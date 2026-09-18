// ============================================================
// /api/account/channels/gmail
//
//   GET    — connection status. Any member can read. Never returns
//            tokens, but DOES include the Pub/Sub push endpoint URL
//            (with its verify token baked in) since that's the exact
//            string an admin needs to paste into Google Cloud Console
//            when creating the push subscription (docs/gmail-setup.md)
//            — same "show the webhook URL for reference" convention
//            whatsapp-channel.tsx already uses.
//   DELETE — disconnect. Admin+. Best-effort stops the Gmail watch
//            registration too.
// ============================================================
import { NextResponse } from 'next/server'

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getValidAccessToken } from '@/lib/gmail/token'
import { stopWatch } from '@/lib/gmail/gmail-api'
import { getOAuthBaseUrl } from '@/lib/gmail/oauth'
import type { GmailConnectionStatus } from '@/types'

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount()

    const { data, error } = await ctx.supabase
      .from('gmail_config')
      .select('email_address, connected_at, needs_reauth, status, watch_expiration, pubsub_verify_token')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (error) {
      console.error('[GET /api/account/channels/gmail] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load Gmail connection' }, { status: 500 })
    }

    const result: GmailConnectionStatus = data
      ? {
          connected: true,
          email_address: data.email_address,
          connected_at: data.connected_at,
          needs_reauth: data.needs_reauth,
          status: data.status,
          pubsub_configured: !!data.watch_expiration,
          push_endpoint_url: `${getOAuthBaseUrl(request)}/api/gmail/webhook?token=${data.pubsub_verify_token}`,
        }
      : { connected: false, needs_reauth: false, status: 'disconnected', pubsub_configured: false, push_endpoint_url: null }

    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE() {
  try {
    const ctx = await requireRole('admin')
    const admin = supabaseAdmin()

    const { data: config } = await admin
      .from('gmail_config')
      .select('*')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (config) {
      try {
        const accessToken = await getValidAccessToken(config)
        await stopWatch({ accessToken })
      } catch (err) {
        console.warn(
          '[DELETE /api/account/channels/gmail] stopWatch failed (continuing):',
          err instanceof Error ? err.message : err,
        )
      }
    }

    const { error } = await ctx.supabase.from('gmail_config').delete().eq('account_id', ctx.accountId)

    if (error) {
      console.error('[DELETE /api/account/channels/gmail] delete error:', error)
      return NextResponse.json({ error: 'Failed to disconnect Gmail' }, { status: 500 })
    }

    return NextResponse.json({ disconnected: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
