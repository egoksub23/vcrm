import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { hasMinRole } from '@/lib/auth/roles'
import { indexArticle } from '@/lib/knowledge/articles'
import {
  PageFetchError,
  checksumOf,
  extractReadablePage,
  fetchWebPage,
  fitPageToArticle,
} from '@/lib/knowledge/web-page'

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/knowledge/[id]/resync   (admin, or the author of the draft)
 *
 * Re-reads the web page an article was imported from and updates the article's
 * text if the page changed. The title stays as it is (it may have been edited
 * by hand). Returns `{ success, changed }`.
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId, role } = await requireRole('agent')
    const limit = checkRateLimit(`kb-import:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const { id } = await params

    const { data: doc } = await supabase
      .from('ai_knowledge_documents')
      .select('id, title, status, created_by, source_id')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle()
    if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const isAdmin = hasMinRole(role, 'admin')
    if (!isAdmin && (doc.status !== 'draft' || doc.created_by !== userId)) {
      return NextResponse.json(
        { error: 'You can only re-sync your own drafts. Ask an admin for published articles.' },
        { status: 403 },
      )
    }

    const { data: source } = doc.source_id
      ? await supabase
          .from('knowledge_sources')
          .select('id, kind, url, checksum')
          .eq('account_id', accountId)
          .eq('id', doc.source_id)
          .maybeSingle()
      : { data: null }
    if (!source || source.kind !== 'url' || !source.url) {
      return NextResponse.json({ error: 'This article was not imported from a web page.' }, { status: 400 })
    }

    const markFailed = async (message: string) => {
      await supabase
        .from('knowledge_sources')
        .update({ sync_status: 'error', sync_error: message.slice(0, 500) })
        .eq('account_id', accountId)
        .eq('id', source.id)
    }

    let fetched
    try {
      fetched = await fetchWebPage(source.url as string)
    } catch (err) {
      if (err instanceof PageFetchError) {
        await markFailed(err.message)
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }
    const page = extractReadablePage(fetched.html, fetched.url)
    if (!page) {
      const message = 'No readable text was found on that page any more.'
      await markFailed(message)
      return NextResponse.json({ error: message }, { status: 422 })
    }
    const fit = fitPageToArticle(page)
    const checksum = checksumOf(page.text)
    const now = new Date().toISOString()

    if (checksum === source.checksum) {
      await supabase
        .from('knowledge_sources')
        .update({ last_synced_at: now, sync_status: 'ok', sync_error: null })
        .eq('account_id', accountId)
        .eq('id', source.id)
      return NextResponse.json({ success: true, changed: false })
    }

    const { data: updated, error } = await supabase
      .from('ai_knowledge_documents')
      .update({ content: fit.text, content_html: fit.html, updated_by: userId })
      .eq('account_id', accountId)
      .eq('id', id)
      .select('id, title, content, status')
      .maybeSingle()
    if (error || !updated) {
      console.error('[knowledge resync] update failed:', error)
      return NextResponse.json({ error: 'Failed to update the article' }, { status: 500 })
    }
    await supabase
      .from('knowledge_sources')
      .update({ checksum, last_synced_at: now, sync_status: 'ok', sync_error: null, url: fetched.url })
      .eq('account_id', accountId)
      .eq('id', source.id)

    const warning = isAdmin
      ? await indexArticle(supabase, accountId, {
          id: updated.id,
          title: updated.title,
          content: updated.content,
          status: updated.status,
        })
      : null
    return NextResponse.json({
      success: true,
      changed: true,
      ...(fit.truncated ? { truncated: true } : {}),
      ...(warning ? { warning } : {}),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
