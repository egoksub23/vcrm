// ============================================================
// POST /api/account/channels/tiktok/webhook  (admin)
//
// Registers this deployment's /api/tiktok/webhook URL with TikTok for
// `comment.update` events. TikTok stores it per developer APP, so this is
// a one-time step (safe to repeat).
// ============================================================
import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getOAuthBaseUrl } from '@/lib/meta/oauth'
import { registerTikTokCommentWebhook, TikTokApiError, tiktokConfigured } from '@/lib/comments/tiktok/api'

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    if (!tiktokConfigured()) {
      return NextResponse.json({ error: 'TikTok is not configured on this server.' }, { status: 409 })
    }
    try {
      await registerTikTokCommentWebhook({ callbackUrl: `${getOAuthBaseUrl(request)}/api/tiktok/webhook` })
    } catch (err) {
      const message = err instanceof TikTokApiError ? err.message : 'TikTok did not accept the webhook.'
      return NextResponse.json({ error: message }, { status: 502 })
    }
    await ctx.supabase
      .from('tiktok_config')
      .update({ webhook_registered_at: new Date().toISOString() })
      .eq('account_id', ctx.accountId)
    return NextResponse.json({ registered: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
