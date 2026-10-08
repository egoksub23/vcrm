import { NextResponse } from 'next/server'
import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { BULK_MAX_IDS, BULK_OPS, runBulkOp } from '@/lib/comments/bulk'
import type { BulkOp } from '@/lib/comments/threads'

/**
 * POST /api/comments/bulk  (comments.moderate)
 * Body: { op: 'resolve' | 'spam' | 'reopen' | 'hide' | 'unhide', ids: string[] }   (at most 50 ids per request)
 *
 * The group buttons and the bulk bar of a post's thread. Returns { results: [{ id, ok, skipped?, error?, reason? }] }, one answer per
 * comment, in the order asked: a comment that could not be changed says why and never stops the others. Deleting is not offered in bulk.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireCapability('comments.moderate')
    const { accountId, userId, supabase } = ctx
    const limit = checkRateLimit(`comment-bulk:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as { op?: unknown; ids?: unknown } | null
    const op = body?.op as BulkOp
    if (!BULK_OPS.includes(op)) return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    const ids = Array.isArray(body?.ids) ? (body.ids as unknown[]) : null
    if (!ids || ids.length === 0 || !ids.every((i) => typeof i === 'string' && i.length > 0 && i.length <= 64)) {
      return NextResponse.json({ error: 'ids must be a list of comment ids' }, { status: 400 })
    }
    if (ids.length > BULK_MAX_IDS) {
      return NextResponse.json({ error: `At most ${BULK_MAX_IDS} comments at a time` }, { status: 400 })
    }

    const results = await runBulkOp({
      userDb: supabase,
      adminDb: supabaseAdmin(),
      ctx: { accountId, userId },
      op,
      ids: ids as string[],
    })
    return NextResponse.json({ results })
  } catch (err) {
    return toErrorResponse(err)
  }
}
