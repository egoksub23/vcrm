// ============================================================
// GET /api/account/channels/messenger/oauth/start
//
// Admin-gated. Creates a pending OAuth connection row, then redirects
// the browser to Meta's Facebook Login for Business dialog. Full-page
// redirect (not a popup) — avoids popup-blocker complexity, matching
// the "Test chat" pattern already used elsewhere in this app.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { buildMetaOAuthUrl, getOAuthBaseUrl } from '@/lib/meta/oauth'
import { createPendingConnection } from '@/lib/meta/oauth-connect'

export async function GET(request: Request) {
  try {
    const ctx = await requireCapability('channels.manage')

    const { state } = await createPendingConnection(supabaseAdmin(), {
      accountId: ctx.accountId,
      userId: ctx.userId,
      channel: 'messenger',
    })

    const redirectUri = `${getOAuthBaseUrl(request)}/api/account/channels/messenger/oauth/callback`
    const withComments = new URL(request.url).searchParams.get('comments') === '1'
    const oauthUrl = buildMetaOAuthUrl({ channel: 'messenger', state, redirectUri, withComments })

    return NextResponse.redirect(oauthUrl)
  } catch (err) {
    return toErrorResponse(err)
  }
}
