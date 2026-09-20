// ============================================================
// GET /api/account/channels/gmail/oauth/start
//
// Admin-gated. Creates a pending OAuth connection row, then redirects
// the browser to Google's sign-in/consent dialog. Full-page redirect
// (not a popup), same reasoning as every other channel's connect flow.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { buildGoogleOAuthUrl, getOAuthBaseUrl } from '@/lib/gmail/oauth'
import { createPendingGmailConnection } from '@/lib/gmail/oauth-connect'

export async function GET(request: Request) {
  try {
    const ctx = await requireCapability('channels.manage')

    const { state } = await createPendingGmailConnection(supabaseAdmin(), {
      accountId: ctx.accountId,
      userId: ctx.userId,
    })

    const redirectUri = `${getOAuthBaseUrl(request)}/api/account/channels/gmail/oauth/callback`
    const oauthUrl = buildGoogleOAuthUrl({ state, redirectUri })

    return NextResponse.redirect(oauthUrl)
  } catch (err) {
    return toErrorResponse(err)
  }
}
