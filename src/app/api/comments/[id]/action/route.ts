import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { performCommentAction } from '@/lib/comments/actions'
import type { CommentAction } from '@/lib/comments/types'

type Params = { params: Promise<{ id: string }> }
const ACTIONS: CommentAction[] = ['reply', 'private_reply', 'hide', 'unhide', 'delete']

/**
 * POST /api/comments/[id]/action  (agent+)
 * Body: { action: 'reply' | 'private_reply' | 'hide' | 'unhide' | 'delete', text? }
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { accountId, userId, role } = await requireRole('agent')
    const limit = checkRateLimit(`comment-action:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const body = (await request.json().catch(() => null)) as { action?: unknown; text?: unknown } | null
    const action = body?.action as CommentAction
    if (!ACTIONS.includes(action)) return NextResponse.json({ error: 'Unknown action' }, { status: 400 })

    // Deleting is destructive on the provider's side; keep it to admins.
    if (action === 'delete' && role !== 'admin' && role !== 'owner') {
      return NextResponse.json({ error: 'Only an admin can delete a comment.' }, { status: 403 })
    }

    const result = await performCommentAction(
      supabaseAdmin(),
      { accountId, userId },
      id,
      action,
      typeof body?.text === 'string' ? body.text : undefined,
    )
    if (!result.ok) {
      return NextResponse.json({ error: result.error, reason: result.reason }, { status: result.status })
    }
    return NextResponse.json({ success: true, comment: result.comment })
  } catch (err) {
    return toErrorResponse(err)
  }
}
