// ============================================================
// GET /api/account/channels/tiktok/oauth/callback
//
// TikTok redirects here with ?code=&state= (or ?auth_code=). The state is
// the auth: it was minted for one account by /oauth/start and cannot be
// guessed. Exchanges the code for tokens and stores them encrypted.
// ============================================================
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getOAuthBaseUrl } from '@/lib/meta/oauth'
import { exchangeTikTokCode, getTikTokAccountInfo } from '@/lib/comments/tiktok/api'
import { encrypt } from '@/lib/whatsapp/encryption'

function settingsRedirect(baseUrl: string, params: Record<string, string>): NextResponse {
  const url = new URL('/settings', baseUrl)
  url.searchParams.set('tab', 'channels')
  url.searchParams.set('channel', 'tiktok')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return NextResponse.redirect(url)
}

export async function GET(request: Request) {
  const baseUrl = getOAuthBaseUrl(request)
  const sp = new URL(request.url).searchParams
  const code = sp.get('code') ?? sp.get('auth_code')
  const state = sp.get('state')
  const oauthError = sp.get('error')

  if (oauthError || !code || !state) {
    return settingsRedirect(baseUrl, { oauth_error: oauthError === 'access_denied' ? 'denied' : 'invalid_state' })
  }

  const db = supabaseAdmin()
  // One use only: read and delete in one go.
  const { data: pending } = await db
    .from('tiktok_oauth_states')
    .delete()
    .eq('state', state)
    .select('account_id, user_id, expires_at')
    .maybeSingle()
  if (!pending || new Date(pending.expires_at as string).getTime() < Date.now()) {
    return settingsRedirect(baseUrl, { oauth_error: 'invalid_state' })
  }
  const accountId = pending.account_id as string

  try {
    const tokens = await exchangeTikTokCode({
      code,
      redirectUri: `${baseUrl}/api/account/channels/tiktok/oauth/callback/`,
    })

    // One TikTok account can only belong to one workspace.
    const { data: taken } = await db
      .from('tiktok_config')
      .select('account_id')
      .eq('open_id', tokens.openId)
      .maybeSingle()
    if (taken && taken.account_id !== accountId) {
      return settingsRedirect(baseUrl, { oauth_error: 'already_connected' })
    }

    const info = await getTikTokAccountInfo({ token: tokens.accessToken, openId: tokens.openId })
    const { error } = await db.from('tiktok_config').upsert(
      {
        account_id: accountId,
        connected_by_user_id: pending.user_id,
        open_id: tokens.openId,
        display_name: info.displayName,
        username: info.username,
        access_token: encrypt(tokens.accessToken),
        refresh_token: encrypt(tokens.refreshToken),
        access_expires_at: tokens.accessExpiresAt.toISOString(),
        refresh_expires_at: tokens.refreshExpiresAt.toISOString(),
        scopes: tokens.scopes,
        needs_reauth: false,
        status: 'connected',
        connected_at: new Date().toISOString(),
      },
      { onConflict: 'account_id' },
    )
    if (error) {
      console.error('[tiktok oauth callback] save failed:', error)
      return settingsRedirect(baseUrl, { oauth_error: 'save_failed' })
    }
    return settingsRedirect(baseUrl, { connected: '1' })
  } catch (err) {
    console.error('[tiktok oauth callback] exchange failed:', err)
    return settingsRedirect(baseUrl, { oauth_error: 'exchange_failed' })
  }
}
