import { NextResponse } from 'next/server'
import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { syncTikTokComments, TikTokReauthRequired } from '@/lib/comments/tiktok/connection'
import { TikTokApiError } from '@/lib/comments/tiktok/api'

export const maxDuration = 60

/**
 * POST /api/comments/sync  (agent+)
 *
 * Pull the latest TikTok comments now. Facebook and Instagram arrive by
 * webhook only, so there is nothing to pull for them.
 */
export async function POST() {
  try {
    const { accountId, userId } = await requireCapability('comments.moderate')
    const limit = checkRateLimit(`comment-sync:${userId}`, { limit: 6, windowMs: 60_000 })
    if (!limit.success) return rateLimitResponse(limit)

    try {
      const r = await syncTikTokComments(supabaseAdmin(), accountId)
      return NextResponse.json({ success: true, ...r })
    } catch (err) {
      if (err instanceof TikTokReauthRequired) {
        return NextResponse.json({ error: 'TikTok needs to be reconnected.', reason: 'reconnect' }, { status: 409 })
      }
      if (err instanceof TikTokApiError) {
        return NextResponse.json({ error: err.message }, { status: 502 })
      }
      throw err
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
