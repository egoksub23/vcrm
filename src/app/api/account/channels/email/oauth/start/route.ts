// ============================================================
// GET /api/account/channels/email/oauth/start
//
// Admin-gated. Creates a pending OAuth connection row, then redirects
// the browser to Microsoft's sign-in/consent dialog. Full-page redirect
// (not a popup), same reasoning as the Messenger/Instagram flow.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { buildMs365OAuthUrl, getOAuthBaseUrl } from '@/lib/ms365/oauth'
import { createPendingEmailConnection } from '@/lib/ms365/oauth-connect'

export async function GET(request: Request) {
  try {
    const ctx = await requireCapability('channels.manage')

    const { state } = await createPendingEmailConnection(supabaseAdmin(), {
      accountId: ctx.accountId,
      userId: ctx.userId,
    })

    const redirectUri = `${getOAuthBaseUrl(request)}/api/account/channels/email/oauth/callback`
    const oauthUrl = buildMs365OAuthUrl({ state, redirectUri })

    return NextResponse.redirect(oauthUrl)
  } catch (err) {
    return toErrorResponse(err)
  }
}
