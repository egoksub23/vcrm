import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsConfig } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { parseDocInput } from '@/lib/ai/knowledge-doc'
import { AiError } from '@/lib/ai/types'
import { hasMinRole } from '@/lib/auth/roles'

type Params = { params: Promise<{ id: string }> }

const FULL_COLUMNS =
  'id, title, content, kind, language, status, use_in_ai, category, review_by, updated_at, created_by, source_conversation_id'

/** GET /api/knowledge/[id] — the full article (any member). */
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
    return NextResponse.json(data)
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * PATCH /api/knowledge/[id]  (agent+)
 *
 * Admins may change anything, including publishing. An agent may only
 * edit their own draft, and cannot publish it.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId, role } = await requireRole('agent')
    const limit = checkRateLimit(`kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const parsed = parseDocInput(await request.json().catch(() => null), { partial: true })
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

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
      if (parsed.fields.status === 'published') {
        return NextResponse.json({ error: 'Only an admin can publish an article.' }, { status: 403 })
      }
    }

    const { data: updated, error } = await supabase
      .from('ai_knowledge_documents')
      .update({ ...parsed.fields, updated_by: userId })
      .eq('account_id', accountId)
      .eq('id', id)
      .select('id, title, content, status')
      .maybeSingle()
    if (error) {
      console.error('[knowledge/[id] PATCH] error:', error)
      return NextResponse.json({ error: 'Failed to update the article' }, { status: 500 })
    }
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // Search index: admins only (an agent's draft has no chunks). Any change
    // to the text, title or status rebuilds the article's chunks; a change
    // to language / category / AI switch needs no re-index (they're read
    // from the article at search time).
    const reindex =
      isAdmin &&
      (parsed.fields.title !== undefined ||
        parsed.fields.content !== undefined ||
        parsed.fields.status !== undefined)
    if (reindex) {
      const { config, corrupt } = await loadEmbeddingsConfig(supabase, accountId)
      try {
        await ingestDocument(supabase, accountId, config, {
          id: updated.id,
          title: updated.title,
          content: updated.content,
          status: updated.status,
        })
      } catch (err) {
        const message = err instanceof AiError ? err.message : 'indexing failed'
        console.error('[knowledge/[id] PATCH] ingest error:', err)
        return NextResponse.json({
          success: true,
          warning: `Saved, but meaning-search indexing failed (${message}). Keyword search still works; use Reindex to retry.`,
        })
      }
      if (corrupt) {
        return NextResponse.json({
          success: true,
          warning:
            'Saved with keyword search only — your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key).',
        })
      }
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

    const { error } = await supabase
      .from('ai_knowledge_documents')
      .delete()
      .eq('account_id', accountId)
      .eq('id', id)
    if (error) {
      console.error('[knowledge/[id] DELETE] error:', error)
      return NextResponse.json({ error: 'Failed to delete the article' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
