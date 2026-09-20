import { NextResponse } from 'next/server'
import { getCurrentAccount, requireAnyCapability, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { parseDocInput, type DocFields } from '@/lib/ai/knowledge-doc'
import { parseStagedAttachments } from '@/lib/knowledge/attachments-input'
import { indexArticle, loadAttachments, removeStoredFiles, syncAttachments } from '@/lib/knowledge/articles'
import { buildTranslationInfos, isTranslationOutOfDate, textUnchanged } from '@/lib/knowledge/translate'
import { keepTranslationsCurrent, loadBaseOf, loadTranslationsOf } from '@/lib/knowledge/translations'
import type { KnowledgeArticle, KnowledgeAttachment, KnowledgeTranslationBase, KnowledgeTranslationInfo, StagedKnowledgeAttachment } from '@/lib/knowledge-types'

type Params = { params: Promise<{ id: string }> }

const FULL_COLUMNS =
  'id, title, content, content_html, kind, language, status, use_in_ai, category, collection_id, review_by, updated_at, created_by, source_conversation_id, source_id, translation_of, machine_translated, translated_from_at'

/**
 * GET /api/knowledge/[id] — the whole article, attachments included (any member).
 *
 * A base article also lists its `translations`; a translation carries its
 * `base`, whether it is `out_of_date`, and, when it has no files of its own,
 * its base's files as `inherited_attachments` (read-only: they are sent with
 * the translation's answers until it gets files of its own).
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { id } = await params
    const { data, error } = await supabase
      .from('ai_knowledge_documents')
      .select(FULL_COLUMNS)
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle()
    if (error) {
      console.error('[knowledge/[id] GET] error:', error)
      return NextResponse.json({ error: 'Failed to load the article' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const { source_id, ...doc } = data as typeof data & { source_id: string | null }
    let sourceKind: 'file' | 'url' | null = null
    let sourceUrl: string | null = null
    if (source_id) {
      const { data: source } = await supabase
        .from('knowledge_sources')
        .select('kind, url')
        .eq('account_id', accountId)
        .eq('id', source_id)
        .maybeSingle()
      sourceKind = (source?.kind as 'file' | 'url' | undefined) ?? null
      sourceUrl = (source?.url as string | null | undefined) ?? null
    }
    const attachments = (await loadAttachments(supabase, accountId, [id])).get(id) ?? []

    let translations: KnowledgeTranslationInfo[] = []
    let base: KnowledgeTranslationBase | null = null
    let outOfDate = false
    let inherited: KnowledgeAttachment[] = []
    if (doc.translation_of) {
      const b = await loadBaseOf(supabase, accountId, doc.translation_of as string)
      if (b) {
        base = { id: b.id, title: b.title, language: b.language, status: b.status, created_by: b.created_by }
        outOfDate = isTranslationOutOfDate(b.updated_at, (doc.translated_from_at as string | null) ?? null)
        if (attachments.length === 0) inherited = (await loadAttachments(supabase, accountId, [b.id])).get(b.id) ?? []
      }
    } else {
      translations = buildTranslationInfos(
        { updated_at: doc.updated_at as string },
        await loadTranslationsOf(supabase, accountId, id),
      )
    }

    const article = {
      ...doc,
      source_kind: sourceKind,
      source_url: sourceUrl,
      attachments,
      out_of_date: outOfDate,
      translations,
      base,
      inherited_attachments: inherited,
    } as unknown as KnowledgeArticle
    return NextResponse.json(article)
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * PATCH /api/knowledge/[id]  (agent+)
 *
 * Admins may change anything, including publishing. An agent may only
 * edit their own draft, and cannot publish it. `attachments` is the whole
 * list: entries with an id are kept, entries without one are new, and any
 * existing attachment not listed is removed.
 *
 * A translation: its language is fixed, and saving it clears
 * `machine_translated` (a person has now reviewed it). Saving a base article
 * without changing its text keeps its translations "up to date"; changing the
 * text is what makes them out of date.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId, capabilities } = await requireAnyCapability(['knowledge.draft', 'knowledge.publish'])
    const limit = checkRateLimit(`kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const { attachments: rawAttachments, ...articleBody } = body ?? {}

    let staged: StagedKnowledgeAttachment[] | null = null
    if (rawAttachments !== undefined) {
      const a = parseStagedAttachments(rawAttachments, accountId)
      if (!a.ok) return NextResponse.json({ error: a.error }, { status: 400 })
      staged = a.items
    }

    let fields: DocFields = {}
    if (Object.keys(articleBody).length > 0 || staged === null) {
      const parsed = parseDocInput(articleBody, { partial: true })
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
      fields = parsed.fields
    }

    const isAdmin = capabilities.has('knowledge.publish')
    const { data: current } = await supabase
      .from('ai_knowledge_documents')
      .select('id, created_by, status, language, translation_of, machine_translated, title, content, content_html, updated_at')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle()
    if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    if (current.translation_of && fields.language !== undefined && fields.language !== current.language) {
      return NextResponse.json({ error: 'The language of a translation cannot be changed.' }, { status: 400 })
    }

    if (!isAdmin) {
      if (current.status !== 'draft' || current.created_by !== userId) {
        return NextResponse.json(
          { error: 'You can only edit your own drafts. Ask an admin to change published articles.' },
          { status: 403 },
        )
      }
      if (fields.status === 'published') {
        return NextResponse.json({ error: 'Only an admin can publish an article.' }, { status: 403 })
      }
    }

    type Saved = { id: string; title: string; content: string; status: 'draft' | 'published'; updated_at?: string }
    let updated: Saved
    if (Object.keys(fields).length > 0) {
      const { data, error } = await supabase
        .from('ai_knowledge_documents')
        .update({
          ...fields,
          updated_by: userId,
          // A person saved it: it is no longer just the machine text.
          ...(current.translation_of && current.machine_translated ? { machine_translated: false } : {}),
        })
        .eq('account_id', accountId)
        .eq('id', id)
        .select('id, title, content, status, updated_at')
        .maybeSingle()
      if (error) {
        if ((error as { code?: string }).code === '23503') {
          return NextResponse.json({ error: 'That collection no longer exists.' }, { status: 400 })
        }
        if ((error as { code?: string }).code === '23514') {
          return NextResponse.json(
            { error: 'A translation of this article already exists in that language. Change or delete it first.' },
            { status: 409 },
          )
        }
        console.error('[knowledge/[id] PATCH] error:', error)
        return NextResponse.json({ error: 'Failed to update the article' }, { status: 500 })
      }
      if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      updated = data as Saved
      // Not a text change (publishing, the AI switch ...): translations that
      // were current stay current.
      if (
        !current.translation_of &&
        updated.updated_at &&
        textUnchanged(current as { title: string; content: string; content_html: string | null }, fields)
      ) {
        await keepTranslationsCurrent(supabase, accountId, id, current.updated_at as string, updated.updated_at)
      }
    } else {
      const { data } = await supabase
        .from('ai_knowledge_documents')
        .select('id, title, content, status')
        .eq('account_id', accountId)
        .eq('id', id)
        .maybeSingle()
      if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      updated = data as Saved
    }

    if (staged !== null) {
      const sync = await syncAttachments(supabase, accountId, userId, id, staged)
      if (!sync.ok) {
        return NextResponse.json({ error: sync.error }, { status: sync.status })
      }
    }

    // Search index: admins only (an agent's draft has no chunks). Any change
    // to the text, title or status rebuilds the article's chunks; a change
    // to language / collection / AI switch needs no re-index (they're read
    // from the article at search time).
    const reindex =
      isAdmin &&
      (fields.title !== undefined || fields.content !== undefined || fields.status !== undefined)
    if (reindex) {
      const warning = await indexArticle(supabase, accountId, {
        id: updated.id,
        title: updated.title,
        content: updated.content,
        status: updated.status,
      })
      if (warning) return NextResponse.json({ success: true, status: updated.status, warning })
    }
    return NextResponse.json({ success: true, status: updated.status })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/knowledge/[id] — an admin, or the author of a draft.
 *
 * Deleting a base article deletes its translations with it (and their files),
 * so a request that would do that is refused with 409 `has_translations`
 * (and the count) unless it carries `?with_translations=true`. Someone who
 * cannot delete every one of the translations (not an admin, and not the
 * author of a draft) cannot delete the article.
 */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId, capabilities } = await requireAnyCapability(['knowledge.draft', 'knowledge.publish'])
    const limit = checkRateLimit(`kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const { id } = await params
    const isAdmin = capabilities.has('knowledge.publish')

    const { data: current } = await supabase
      .from('ai_knowledge_documents')
      .select('created_by, status')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle()
    if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!isAdmin && (current.status !== 'draft' || current.created_by !== userId)) {
      return NextResponse.json(
        { error: 'You can only delete your own drafts.' },
        { status: 403 },
      )
    }

    const { data: children } = await supabase
      .from('ai_knowledge_documents')
      .select('id, status, created_by')
      .eq('account_id', accountId)
      .eq('translation_of', id)
    const translations = (children ?? []) as { id: string; status: string; created_by: string | null }[]
    if (translations.length > 0) {
      if (!isAdmin && translations.some((t) => t.status !== 'draft' || t.created_by !== userId)) {
        return NextResponse.json(
          { error: 'This article has translations you cannot delete. Ask an admin.' },
          { status: 403 },
        )
      }
      if (new URL(request.url).searchParams.get('with_translations') !== 'true') {
        return NextResponse.json(
          {
            error: `This article has ${translations.length} translation${translations.length === 1 ? '' : 's'} that would be deleted with it.`,
            code: 'has_translations',
            count: translations.length,
          },
          { status: 409 },
        )
      }
    }

    // Remember the files (the article and its translations) so they can be
    // removed once the rows are gone.
    const { data: files } = await supabase
      .from('knowledge_attachments')
      .select('storage_path')
      .eq('account_id', accountId)
      .in('document_id', [id, ...translations.map((t) => t.id)])

    const { error } = await supabase
      .from('ai_knowledge_documents')
      .delete()
      .eq('account_id', accountId)
      .eq('id', id)
    if (error) {
      console.error('[knowledge/[id] DELETE] error:', error)
      return NextResponse.json({ error: 'Failed to delete the article' }, { status: 500 })
    }
    await removeStoredFiles(
      supabase,
      accountId,
      ((files ?? []) as { storage_path: string }[]).map((f) => f.storage_path),
    )
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
