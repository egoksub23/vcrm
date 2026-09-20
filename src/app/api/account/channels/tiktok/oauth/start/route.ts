// ============================================================
// GET /api/account/channels/tiktok/oauth/start
//
// Admin-gated. Mints a one-time `state` (CSRF token that also tells the
// callback which account this is for), then sends the browser to TikTok's
// authorization page.
// ============================================================
import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getOAuthBaseUrl } from '@/lib/meta/oauth'
import { buildTikTokAuthUrl, tiktokConfigured } from '@/lib/comments/tiktok/api'

export async function GET(request: Request) {
  try {
    const ctx = await requireCapability('channels.manage')
    const baseUrl = getOAuthBaseUrl(request)

    if (!tiktokConfigured()) {
      const url = new URL('/settings', baseUrl)
      url.searchParams.set('tab', 'channels')
      url.searchParams.set('channel', 'tiktok')
      url.searchParams.set('oauth_error', 'not_configured')
      return NextResponse.redirect(url)
    }

    const state = randomBytes(32).toString('base64url')
    const { error } = await supabaseAdmin()
      .from('tiktok_oauth_states')
      .insert({ state, account_id: ctx.accountId, user_id: ctx.userId })
    if (error) {
      console.error('[tiktok oauth start] state insert failed:', error)
      return NextResponse.json({ error: 'Could not start the TikTok connection' }, { status: 500 })
    }

    // TikTok requires the redirect URL to end with a slash.
    const redirectUri = `${baseUrl}/api/account/channels/tiktok/oauth/callback/`
    return NextResponse.redirect(buildTikTokAuthUrl({ state, redirectUri }))
  } catch (err) {
    return toErrorResponse(err)
  }
}
