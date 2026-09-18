// ============================================================
// GET /api/account/channels/gmail/oauth/callback
//
// Google redirects here with ?code=&state= after the admin approves
// the consent dialog. No requireRole here — same reasoning as every
// other channel's callback: the state token IS the auth (32 random
// bytes, minted for a specific account by /oauth/start).
//
// Also registers Gmail push notifications (users.watch) against the
// operator's own Pub/Sub topic (GMAIL_PUBSUB_TOPIC) — unlike Microsoft
// 365's subscription, which this app can create outright, the Pub/Sub
// topic + push subscription themselves are one-time manual GCP setup
// (see docs/gmail-setup.md); this call only registers Gmail's *side*
// of pushing to whatever topic already exists. If the env var isn't
// set, the connection still succeeds (sending still works) but skips
// watch registration — the Settings panel flags that inbound needs it.
// ============================================================
import { NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { exchangeCodeForTokens, getUserEmailAddress, getOAuthBaseUrl } from '@/lib/gmail/oauth'
import { watchMailbox, getCurrentHistoryId } from '@/lib/gmail/gmail-api'
import {
  findPendingGmailConnectionByState,
  markGmailConnectionCompleted,
  markGmailConnectionFailed,
} from '@/lib/gmail/oauth-connect'
import { encrypt } from '@/lib/whatsapp/encryption'

function settingsRedirect(baseUrl: string, params: Record<string, string>): NextResponse {
  const url = new URL('/settings', baseUrl)
  url.searchParams.set('tab', 'channels')
  url.searchParams.set('channel', 'gmail')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return NextResponse.redirect(url)
}

export async function GET(request: Request) {
  const baseUrl = getOAuthBaseUrl(request)
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const oauthError =
    searchParams.get('error') === 'access_denied' ? 'denied' : searchParams.get('error')

  if (oauthError || !code || !state) {
    return settingsRedirect(baseUrl, { oauth_error: oauthError || 'invalid_state' })
  }

  const db = supabaseAdmin()
  const pending = await findPendingGmailConnectionByState(db, state)
  if (!pending) {
    return settingsRedirect(baseUrl, { oauth_error: 'invalid_state' })
  }

  try {
    const redirectUri = `${baseUrl}/api/account/channels/gmail/oauth/callback`
    const tokens = await exchangeCodeForTokens({ code, redirectUri })
    const emailAddress = await getUserEmailAddress({ accessToken: tokens.accessToken })

    const { data: existing } = await db
      .from('gmail_config')
      .select('id, pubsub_verify_token, history_id')
      .eq('account_id', pending.account_id)
      .maybeSingle()

    const pubsubTopic = process.env.GMAIL_PUBSUB_TOPIC?.trim()
    let watchExpiration: string | null = null
    if (pubsubTopic) {
      const watch = await watchMailbox({ accessToken: tokens.accessToken, topicName: pubsubTopic })
      watchExpiration = watch.expiration
    }
    // Re-registering the watch (or just re-authenticating) does NOT
    // reset Gmail's history log — only establish a fresh historyId
    // baseline the FIRST time this account connects. Overwriting an
    // already-set history_id on a reconnect would silently skip every
    // message that arrived between the last processed notification
    // and this reconnect (see the same reasoning in
    // src/app/api/gmail/watch-renew/route.ts).
    const historyId =
      existing?.history_id ?? (await getCurrentHistoryId({ accessToken: tokens.accessToken }).catch(() => null))

    const row = {
      account_id: pending.account_id,
      connected_by_user_id: pending.initiated_by_user_id,
      email_address: emailAddress,
      access_token: encrypt(tokens.accessToken),
      access_token_expires_at: new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString(),
      refresh_token: encrypt(tokens.refreshToken),
      history_id: historyId,
      watch_expiration: watchExpiration,
      // Keep the existing verify token on a reconnect (it's already
      // baked into the operator's Pub/Sub push subscription URL) —
      // only generate a fresh one for a brand-new connection.
      pubsub_verify_token: existing?.pubsub_verify_token ?? randomBytes(24).toString('base64url'),
      needs_reauth: false,
      status: 'connected' as const,
      connected_at: new Date().toISOString(),
    }

    if (existing) {
      await db.from('gmail_config').update(row).eq('id', existing.id)
    } else {
      await db.from('gmail_config').insert(row)
    }
    await markGmailConnectionCompleted(db, pending.id)
    return settingsRedirect(baseUrl, { connected: '1' })
  } catch (err) {
    console.error('[gmail oauth callback] failed:', err)
    await markGmailConnectionFailed(db, pending.id)
    return settingsRedirect(baseUrl, { oauth_error: 'unknown' })
  }
}
