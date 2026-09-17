// ============================================================
// GET /api/account/channels/instagram/oauth/callback
//
// Same code-exchange shape as Messenger's callback, plus one extra
// step per candidate Page: resolving whether it has a linked Instagram
// professional account at all (`getInstagramBusinessAccount`) — a Page
// with no linked IG account can't be used for this channel.
// ============================================================
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { encrypt } from '@/lib/whatsapp/encryption'
import {
  exchangeCodeForUserToken,
  exchangeForLongLivedToken,
  getInstagramBusinessAccount,
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

function settingsRedirect(baseUrl: string, params: Record<string, string>): NextResponse {
  const url = new URL('/settings', baseUrl)
  url.searchParams.set('tab', 'channels')
  url.searchParams.set('channel', 'instagram')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return NextResponse.redirect(url)
}

export async function GET(request: Request) {
  const baseUrl = getOAuthBaseUrl(request)
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const oauthError = searchParams.get('error') === 'access_denied' ? 'denied' : searchParams.get('error')

  if (oauthError || !code || !state) {
    return settingsRedirect(baseUrl, { oauth_error: oauthError || 'invalid_state' })
  }

  const db = supabaseAdmin()
  const pending = await findPendingConnectionByState(db, state)
  if (!pending || pending.channel !== 'instagram') {
    return settingsRedirect(baseUrl, { oauth_error: 'invalid_state' })
  }

  try {
    const redirectUri = `${baseUrl}/api/account/channels/instagram/oauth/callback`
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
      const igAccount = await getInstagramBusinessAccount({
        pageId: page.id,
        pageAccessToken: page.accessToken,
      })
      if (!igAccount) {
        await markFailed(db, pending.id)
        return settingsRedirect(baseUrl, { oauth_error: 'no_ig_account' })
      }

      const { data: existing } = await db
        .from('instagram_config')
        .select('id')
        .eq('account_id', pending.account_id)
        .maybeSingle()
      const row = {
        account_id: pending.account_id,
        connected_by_user_id: pending.initiated_by_user_id,
        page_id: page.id,
        ig_business_account_id: igAccount.id,
        ig_username: igAccount.username ?? null,
        page_access_token: encrypt(page.accessToken),
        long_lived_user_token: encrypt(longLived),
        needs_reauth: false,
        status: 'connected' as const,
        connected_at: new Date().toISOString(),
      }
      if (existing) {
        await db.from('instagram_config').update(row).eq('id', existing.id)
      } else {
        await db.from('instagram_config').insert(row)
      }
      await markCompleted(db, pending.id)
      return settingsRedirect(baseUrl, { connected: '1' })
    }

    await markAwaitingPageSelection(db, pending.id, pages)
    return settingsRedirect(baseUrl, { oauth: 'select_page', connection_id: pending.id })
  } catch (err) {
    console.error('[instagram oauth callback] failed:', err)
    await markFailed(db, pending.id)
    return settingsRedirect(baseUrl, { oauth_error: 'unknown' })
  }
}
