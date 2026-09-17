// ============================================================
// GET /api/account/channels/email/oauth/callback
//
// Microsoft redirects here with ?code=&state= after the admin approves
// the consent dialog. No requireRole here — same reasoning as the
// Messenger/Instagram callback: the state token IS the auth (32 random
// bytes, minted for a specific account by /oauth/start).
//
// Unlike Messenger/Instagram there's no Page-picker branch — a
// Microsoft 365 connection is always the signed-in user's own single
// mailbox — so this exchanges the code, fetches the mailbox profile,
// creates the Graph change-notification subscription, and upserts
// email_config in one pass.
// ============================================================
import { NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { exchangeCodeForTokens, getMailboxProfile, getOAuthBaseUrl } from '@/lib/ms365/oauth'
import { createSubscription } from '@/lib/ms365/mail-api'
import {
  findPendingEmailConnectionByState,
  markEmailConnectionCompleted,
  markEmailConnectionFailed,
} from '@/lib/ms365/oauth-connect'
import { encrypt } from '@/lib/whatsapp/encryption'

function settingsRedirect(baseUrl: string, params: Record<string, string>): NextResponse {
  const url = new URL('/settings', baseUrl)
  url.searchParams.set('tab', 'channels')
  url.searchParams.set('channel', 'email')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return NextResponse.redirect(url)
}

export async function GET(request: Request) {
  const baseUrl = getOAuthBaseUrl(request)
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  // Microsoft's own error code when the admin cancels the consent dialog.
  const oauthError =
    searchParams.get('error') === 'access_denied' ? 'denied' : searchParams.get('error')

  if (oauthError || !code || !state) {
    return settingsRedirect(baseUrl, { oauth_error: oauthError || 'invalid_state' })
  }

  const db = supabaseAdmin()
  const pending = await findPendingEmailConnectionByState(db, state)
  if (!pending) {
    return settingsRedirect(baseUrl, { oauth_error: 'invalid_state' })
  }

  try {
    const redirectUri = `${baseUrl}/api/account/channels/email/oauth/callback`
    const tokens = await exchangeCodeForTokens({ code, redirectUri })
    const mailbox = await getMailboxProfile({ accessToken: tokens.accessToken })

    const clientState = randomBytes(24).toString('base64url')
    const notificationUrl = `${baseUrl}/api/email/webhook`
    const subscription = await createSubscription({
      accessToken: tokens.accessToken,
      notificationUrl,
      clientState,
    })

    const { data: existing } = await db
      .from('email_config')
      .select('id')
      .eq('account_id', pending.account_id)
      .maybeSingle()

    const row = {
      account_id: pending.account_id,
      connected_by_user_id: pending.initiated_by_user_id,
      mailbox_user_id: mailbox.id,
      mailbox_address: mailbox.address,
      access_token: encrypt(tokens.accessToken),
      access_token_expires_at: new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString(),
      refresh_token: encrypt(tokens.refreshToken),
      client_state: encrypt(clientState),
      subscription_id: subscription.id,
      subscription_expires_at: subscription.expirationDateTime,
      needs_reauth: false,
      status: 'connected' as const,
      connected_at: new Date().toISOString(),
    }

    if (existing) {
      await db.from('email_config').update(row).eq('id', existing.id)
    } else {
      await db.from('email_config').insert(row)
    }
    await markEmailConnectionCompleted(db, pending.id)
    return settingsRedirect(baseUrl, { connected: '1' })
  } catch (err) {
    console.error('[email oauth callback] failed:', err)
    await markEmailConnectionFailed(db, pending.id)
    return settingsRedirect(baseUrl, { oauth_error: 'unknown' })
  }
}
