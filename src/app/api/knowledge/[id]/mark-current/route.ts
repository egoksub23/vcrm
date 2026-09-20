import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadBaseOf } from '@/lib/knowledge/translations'

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/knowledge/[id]/mark-current  (agent+)
 *
 * "Mark up to date" on a translation: the person has read the base article's
 * newer version and decided the translation still says the right thing, so
 * its "out of date" flag is cleared (`translated_from_at` moves to the base's
 * current `updated_at`). The text is not touched and nothing is translated.
 * Admins may do this on any translation, others on their own drafts.
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId, role } = await requireRole('agent')
    const limit = checkRateLimit(`kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const { id } = await params

    const { data: doc } = await supabase
      .from('ai_knowledge_documents')
      .select('id, translation_of, status, created_by')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle()
    if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!doc.translation_of) {
      return NextResponse.json({ error: 'Only a translation can be marked up to date.' }, { status: 400 })
    }
    if (!hasMinRole(role, 'admin') && (doc.status !== 'draft' || doc.created_by !== userId)) {
      return NextResponse.json({ error: 'You can only change your own drafts. Ask an admin.' }, { status: 403 })
    }

    const base = await loadBaseOf(supabase, accountId, doc.translation_of as string)
    if (!base) return NextResponse.json({ error: 'The original article no longer exists.' }, { status: 404 })

    const { data, error } = await supabase
      .from('ai_knowledge_documents')
      .update({ translated_from_at: base.updated_at })
      .eq('account_id', accountId)
      .eq('id', id)
      .select('id')
      .maybeSingle()
    if (error) {
      console.error('[knowledge mark-current] error:', error)
      return NextResponse.json({ error: 'Failed to update the translation' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'You cannot change this translation.' }, { status: 403 })
    return NextResponse.json({ success: true, translated_from_at: base.updated_at })
  } catch (err) {
    return toErrorResponse(err)
  }
}
