// ============================================================
// GET /api/account/channels/email/oauth/callback
//
// Microsoft redirects here with ?code=&state= after the admin approves
// the consent dialog. The state token (32 random bytes, minted for one
// person in one account by /oauth/start) is single-use and bound to the
// signed-in session, same as the Messenger/Instagram callback: only the
// person who started it can finish it (lib/oauth/session-binding).
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
import { sessionOwnsPending } from '@/lib/oauth/session-binding'
import { exchangeCodeForTokens, getMailboxProfile, getOAuthBaseUrl } from '@/lib/ms365/oauth'
import { inboxIsOff } from '@/lib/email/mailbox-types'
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
    // Microsoft's error_description carries the actual reason (e.g. which
    // parameter it rejected) — logged here rather than surfaced to the
    // user, since it can contain a correlation/request id worth having
    // for support but isn't meaningful UI copy. This branch fires before
    // any of our own code runs (Microsoft rejected the /authorize request
    // itself), so there's nothing else to log leading up to it.
    if (oauthError) {
      console.error(
        '[email oauth callback] Microsoft rejected the request:',
        oauthError,
        searchParams.get('error_description'),
      )
    }
    return settingsRedirect(baseUrl, { oauth_error: oauthError || 'invalid_state' })
  }

  const db = supabaseAdmin()
  const pending = await findPendingEmailConnectionByState(db, state)
  // Single-use, and only the person who started it (same workspace) can finish it.
  if (!pending || pending.status !== 'pending' || !(await sessionOwnsPending(pending))) {
    return settingsRedirect(baseUrl, { oauth_error: 'invalid_state' })
  }

  try {
    const redirectUri = `${baseUrl}/api/account/channels/email/oauth/callback`
    const tokens = await exchangeCodeForTokens({ code, redirectUri })
    const mailbox = await getMailboxProfile({ accessToken: tokens.accessToken })

    // A mailbox belongs to one workspace only (migration 136). Refuse
    // BEFORE creating a change-notification subscription for it.
    const { data: taken } = await db
      .from('email_config')
      .select('id')
      .eq('mailbox_user_id', mailbox.id)
      .neq('account_id', pending.account_id)
      .limit(1)
    if (taken && taken.length > 0) {
      await markEmailConnectionFailed(db, pending.id)
      return settingsRedirect(baseUrl, { oauth_error: 'mailbox_in_use' })
    }

    const { data: existing } = await db
      .from('email_config')
      .select('id, inbox_enabled')
      .eq('account_id', pending.account_id)
      .maybeSingle()

    // A reconnect of a mailbox that is not used for the customer care inbox (migration 179) keeps it that way: no subscription is created, so
    // reconnecting a send-only mailbox never starts putting its mail into the Inbox. The switch is in Settings > Channels > Email.
    const inboxOff = !!existing && inboxIsOff(existing)

    const clientState = randomBytes(24).toString('base64url')
    const notificationUrl = `${baseUrl}/api/email/webhook`
    const subscription = inboxOff
      ? null
      : await createSubscription({
          accessToken: tokens.accessToken,
          notificationUrl,
          clientState,
        })

    const row = {
      account_id: pending.account_id,
      connected_by_user_id: pending.initiated_by_user_id,
      mailbox_user_id: mailbox.id,
      mailbox_address: mailbox.address,
      access_token: encrypt(tokens.accessToken),
      access_token_expires_at: new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString(),
      refresh_token: encrypt(tokens.refreshToken),
      client_state: encrypt(clientState),
      subscription_id: subscription?.id ?? null,
      subscription_expires_at: subscription?.expirationDateTime ?? null,
      subscription_notification_url: subscription ? notificationUrl : null,
      needs_reauth: false,
      status: 'connected' as const,
      connected_at: new Date().toISOString(),
    }

    const { error: saveError } = existing
      ? await db.from('email_config').update(row).eq('id', existing.id)
      : await db.from('email_config').insert(row)
    if (saveError) {
      // The unique index is the backstop for two connections racing.
      if (saveError.code === '23505') {
        await markEmailConnectionFailed(db, pending.id)
        return settingsRedirect(baseUrl, { oauth_error: 'mailbox_in_use' })
      }
      throw saveError
    }
    await markEmailConnectionCompleted(db, pending.id)
    return settingsRedirect(baseUrl, { connected: '1' })
  } catch (err) {
    console.error('[email oauth callback] failed:', err)
    await markEmailConnectionFailed(db, pending.id)
    return settingsRedirect(baseUrl, { oauth_error: 'unknown' })
  }
}
