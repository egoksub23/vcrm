// ============================================================
// GET /api/account/channels/instagram/oauth/start
// Same shape as the Messenger route — see that file for comments.
// ============================================================
import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { buildMetaOAuthUrl, getOAuthBaseUrl } from '@/lib/meta/oauth'
import { createPendingConnection } from '@/lib/meta/oauth-connect'

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const { state } = await createPendingConnection(supabaseAdmin(), {
      accountId: ctx.accountId,
      userId: ctx.userId,
      channel: 'instagram',
    })

    const redirectUri = `${getOAuthBaseUrl(request)}/api/account/channels/instagram/oauth/callback`
    const oauthUrl = buildMetaOAuthUrl({ channel: 'instagram', state, redirectUri })

    return NextResponse.redirect(oauthUrl)
  } catch (err) {
    return toErrorResponse(err)
  }
}
