// ============================================================
// What every /api/account/channels/vircle-chat route checks after
// `requireCapability('channels.manage')` (each route still calls that itself,
// so the capability is visible in the route's own source):
//   1. the caller is not hammering the admin endpoints (RATE_LIMITS.adminAction);
//   2. the operator has Vircle Chat switched on for the workspace.
// ============================================================

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

import { vircleChatEnabled } from './feature'

export const VIRCLE_CHAT_DISABLED_MESSAGE = 'Vircle Chat is not enabled for this workspace'

/** The refusal for a workspace whose operator flag is off. */
export function vircleChatDisabledResponse(): NextResponse {
  return NextResponse.json({ error: VIRCLE_CHAT_DISABLED_MESSAGE }, { status: 403 })
}

/**
 * Null when the caller may go on, otherwise the response to return. `bucket`
 * names the rate-limit bucket; leave it out for a read that needs no limit.
 */
export async function vircleChatGate(
  admin: SupabaseClient,
  ctx: { userId: string; accountId: string },
  bucket?: string,
): Promise<NextResponse | null> {
  if (bucket) {
    const limit = checkRateLimit(`admin:${bucket}:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
  }
  if (!(await vircleChatEnabled(admin, ctx.accountId))) return vircleChatDisabledResponse()
  return null
}
