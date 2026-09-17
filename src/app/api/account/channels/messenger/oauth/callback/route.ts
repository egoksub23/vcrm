// ============================================================
// GET /api/account/channels/messenger/oauth/callback
//
// Meta redirects here with ?code=&state= after the admin approves
// the OAuth dialog. No requireRole here — Meta's redirect carries no
// session-proof beyond the state token itself, which IS the auth: it
// was minted for a specific account by /oauth/start and can't be
// guessed (32 random bytes). Exchanges the code for a long-lived user
// token, lists the admin's Pages, and either auto-connects (1 Page) or
// hands off to the picker UI (>1 Page).
// ============================================================
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import {
  exchangeCodeForUserToken,
  exchangeForLongLivedToken,
  getOAuthBaseUrl,
  getPageAccessToken,
  listUserPages,
} from '@/lib/meta/oauth'
import {
  findPendingConnectionByState,
  markAwaitingPageSelection,
  markCompleted,
  markFailed,
  storeLongLivedToken,
} from '@/lib/meta/oauth-connect'
import { encrypt } from '@/lib/whatsapp/encryption'

function settingsRedirect(baseUrl: string, params: Record<string, string>): NextResponse {
  const url = new URL('/settings', baseUrl)
  url.searchParams.set('tab', 'channels')
  url.searchParams.set('channel', 'messenger')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return NextResponse.redirect(url)
}

export async function GET(request: Request) {
  const baseUrl = getOAuthBaseUrl(request)
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  // Meta's own error code when the admin cancels the consent dialog.
  const oauthError = searchParams.get('error') === 'access_denied' ? 'denied' : searchParams.get('error')

  if (oauthError || !code || !state) {
    return settingsRedirect(baseUrl, { oauth_error: oauthError || 'invalid_state' })
  }

  const db = supabaseAdmin()
  const pending = await findPendingConnectionByState(db, state)
  if (!pending || pending.channel !== 'messenger') {
    return settingsRedirect(baseUrl, { oauth_error: 'invalid_state' })
  }

  try {
    const redirectUri = `${baseUrl}/api/account/channels/messenger/oauth/callback`
    const { accessToken: shortLived } = await exchangeCodeForUserToken({ code, redirectUri })
    const { accessToken: longLived } = await exchangeForLongLivedToken({
      shortLivedToken: shortLived,
    })
    await storeLongLivedToken(db, pending.id, longLived)

    const pages = await listUserPages({ userAccessToken: longLived })

    if (pages.length === 0) {
      await markFailed(db, pending.id)
      return settingsRedirect(baseUrl, { oauth_error: 'no_pages' })
    }

    if (pages.length === 1) {
      const page = await getPageAccessToken({ userAccessToken: longLived, pageId: pages[0].id })
      if (!page) {
        await markFailed(db, pending.id)
        return settingsRedirect(baseUrl, { oauth_error: 'no_pages' })
      }
      const { data: existing } = await db
        .from('messenger_config')
        .select('id')
        .eq('account_id', pending.account_id)
        .maybeSingle()
      const row = {
        account_id: pending.account_id,
        connected_by_user_id: pending.initiated_by_user_id,
        page_id: page.id,
        page_name: page.name,
        page_access_token: encrypt(page.accessToken),
        long_lived_user_token: encrypt(longLived),
        needs_reauth: false,
        status: 'connected' as const,
        connected_at: new Date().toISOString(),
      }
      if (existing) {
        await db.from('messenger_config').update(row).eq('id', existing.id)
      } else {
        await db.from('messenger_config').insert(row)
      }
      await markCompleted(db, pending.id)
      return settingsRedirect(baseUrl, { connected: '1' })
    }

    await markAwaitingPageSelection(db, pending.id, pages)
    return settingsRedirect(baseUrl, { oauth: 'select_page', connection_id: pending.id })
  } catch (err) {
    console.error('[messenger oauth callback] failed:', err)
    await markFailed(db, pending.id)
    return settingsRedirect(baseUrl, { oauth_error: 'unknown' })
  }
}
