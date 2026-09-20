import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { parseDocInput, type DocFields } from '@/lib/ai/knowledge-doc'
import { hasMinRole } from '@/lib/auth/roles'
import { parseStagedAttachments } from '@/lib/knowledge/attachments-input'
import { indexArticle, loadAttachments, removeStoredFiles, syncAttachments } from '@/lib/knowledge/articles'
import type { KnowledgeArticle, StagedKnowledgeAttachment } from '@/lib/knowledge-types'

type Params = { params: Promise<{ id: string }> }

const FULL_COLUMNS =
  'id, title, content, content_html, kind, language, status, use_in_ai, category, collection_id, review_by, updated_at, created_by, source_conversation_id, source_id'

/** GET /api/knowledge/[id] — the whole article, attachments included (any member). */
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

    const article = {
      ...doc,
      source_kind: sourceKind,
      source_url: sourceUrl,
      attachments,
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
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId, role } = await requireRole('agent')
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

    const isAdmin = hasMinRole(role, 'admin')
    const { data: current } = await supabase
      .from('ai_knowledge_documents')
      .select('id, created_by, status')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle()
    if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 })

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

    type Saved = { id: string; title: string; content: string; status: 'draft' | 'published' }
    let updated: Saved
    if (Object.keys(fields).length > 0) {
      const { data, error } = await supabase
        .from('ai_knowledge_documents')
        .update({ ...fields, updated_by: userId })
        .eq('account_id', accountId)
        .eq('id', id)
        .select('id, title, content, status')
        .maybeSingle()
      if (error) {
        if ((error as { code?: string }).code === '23503') {
          return NextResponse.json({ error: 'That collection no longer exists.' }, { status: 400 })
        }
        console.error('[knowledge/[id] PATCH] error:', error)
        return NextResponse.json({ error: 'Failed to update the article' }, { status: 500 })
      }
      if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      updated = data as Saved
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

/** DELETE /api/knowledge/[id] — an admin, or the author of a draft. */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId, role } = await requireRole('agent')
    const limit = checkRateLimit(`kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const { id } = await params

    if (!hasMinRole(role, 'admin')) {
      const { data: current } = await supabase
        .from('ai_knowledge_documents')
        .select('created_by, status')
        .eq('account_id', accountId)
        .eq('id', id)
        .maybeSingle()
      if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      if (current.status !== 'draft' || current.created_by !== userId) {
        return NextResponse.json(
          { error: 'You can only delete your own drafts.' },
          { status: 403 },
        )
      }
    }

    // Remember the files so they can be removed once the rows are gone.
    const { data: files } = await supabase
      .from('knowledge_attachments')
      .select('storage_path')
      .eq('account_id', accountId)
      .eq('document_id', id)

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
