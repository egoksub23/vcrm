import { NextResponse } from 'next/server'
import { requireAnyCapability, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { indexArticle } from '@/lib/knowledge/articles'

type Params = { params: Promise<{ id: string; versionId: string }> }

/**
 * POST /api/knowledge/[id]/versions/[versionId]/restore   (admin, or the
 * author of the draft)
 *
 * Puts an earlier version's title and text back. That is an ordinary edit, so
 * it is snapshotted too and can itself be undone.
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId, capabilities } = await requireAnyCapability(['knowledge.draft', 'knowledge.publish'])
    const limit = checkRateLimit(`kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const { id, versionId } = await params

    const { data: doc } = await supabase
      .from('ai_knowledge_documents')
      .select('id, created_by, status')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle()
    if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const isAdmin = capabilities.has('knowledge.publish')
    if (!isAdmin && (doc.status !== 'draft' || doc.created_by !== userId)) {
      return NextResponse.json(
        { error: 'You can only restore versions of your own drafts. Ask an admin for published articles.' },
        { status: 403 },
      )
    }

    const { data: version } = await supabase
      .from('knowledge_document_versions')
      .select('title, content, content_html')
      .eq('account_id', accountId)
      .eq('document_id', id)
      .eq('id', versionId)
      .maybeSingle()
    if (!version) return NextResponse.json({ error: 'Version not found' }, { status: 404 })

    const { data: updated, error } = await supabase
      .from('ai_knowledge_documents')
      .update({
        title: version.title,
        content: version.content,
        content_html: version.content_html,
        updated_by: userId,
      })
      .eq('account_id', accountId)
      .eq('id', id)
      .select('id, title, content, status')
      .maybeSingle()
    if (error) {
      console.error('[knowledge/versions restore] error:', error)
      return NextResponse.json({ error: 'Failed to restore the version' }, { status: 500 })
    }
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    if (isAdmin) {
      const warning = await indexArticle(supabase, accountId, {
        id: updated.id,
        title: updated.title,
        content: updated.content,
        status: updated.status,
      })
      if (warning) return NextResponse.json({ success: true, warning })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
