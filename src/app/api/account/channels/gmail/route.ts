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
//            Also { enabled, inbox_enabled, send_problem }: see PATCH.
//   PATCH  — two independent switches, either or both (admin+):
//              { enabled }       the master pause (migration 097): nothing
//                                in, nothing out. Leaves the saved token
//                                and watch untouched.
//              { inbox_enabled } use the mailbox for the customer care
//                                inbox (migration 179). Off stops the Gmail
//                                push watch (nothing new is ingested; the
//                                mailbox still sends Halo's own email), on
//                                registers a new one and ingests from then on.
//   DELETE — disconnect. Admin+. Best-effort stops the Gmail watch
//            registration too.
// ============================================================
import { NextResponse } from 'next/server'

import { getCurrentAccount, requireCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { mailboxSendProblem } from '@/lib/email/mailbox-types'
import { getValidAccessToken } from '@/lib/gmail/token'
import { stopWatch } from '@/lib/gmail/gmail-api'
import { realGmailInboxDeps, setGmailInbox } from '@/lib/gmail/inbox-switch'
import { getOAuthBaseUrl } from '@/lib/gmail/oauth'
import type { GmailConnectionStatus } from '@/types'

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount()

    const { data, error } = await ctx.supabase
      .from('gmail_config')
      .select('email_address, connected_at, needs_reauth, status, watch_expiration, pubsub_verify_token, enabled, inbox_enabled')
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
          enabled: data.enabled,
          inbox_enabled: data.inbox_enabled,
          // whether Halo can send its own email through the mailbox (Secure Sign, invitations, notifications): the inbox switch plays no part
          send_problem: mailboxSendProblem(data),
        }
      : { connected: false, needs_reauth: false, status: 'disconnected', pubsub_configured: false, push_endpoint_url: null }

    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE() {
  try {
    const ctx = await requireCapability('channels.manage')
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

export async function PATCH(request: Request) {
  try {
    const ctx = await requireCapability('channels.manage')
    const body = (await request.json().catch(() => null)) as { enabled?: unknown; inbox_enabled?: unknown } | null
    const wantsEnabled = body?.enabled !== undefined
    const wantsInbox = body?.inbox_enabled !== undefined
    if (!wantsEnabled && !wantsInbox) {
      return NextResponse.json({ error: 'enabled or inbox_enabled is required' }, { status: 400 })
    }
    if (wantsEnabled && typeof body?.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 })
    }
    if (wantsInbox && typeof body?.inbox_enabled !== 'boolean') {
      return NextResponse.json({ error: 'inbox_enabled must be a boolean' }, { status: 400 })
    }

    const result: Record<string, unknown> = { success: true }

    if (wantsEnabled) {
      const { error } = await ctx.supabase
        .from('gmail_config')
        .update({ enabled: body!.enabled })
        .eq('account_id', ctx.accountId)

      if (error) {
        console.error('[PATCH /api/account/channels/gmail] update error:', error)
        return NextResponse.json({ error: 'Failed to update Gmail' }, { status: 500 })
      }
      result.enabled = body!.enabled
    }

    if (wantsInbox) {
      // The flag is written as the signed-in person (so the audit trail names them); the watch is the service role's.
      const outcome = await setGmailInbox(
        { accountId: ctx.accountId, enabled: body!.inbox_enabled as boolean },
        realGmailInboxDeps(async (accountId, value) => {
          const { error } = await ctx.supabase.from('gmail_config').update({ inbox_enabled: value }).eq('account_id', accountId)
          return error ? { message: error.message } : null
        }),
      )
      if (!outcome.ok) {
        return NextResponse.json({ error: outcome.error, code: outcome.code }, { status: outcome.status })
      }
      result.inbox_enabled = outcome.inbox_enabled
      result.watch = outcome.watch
    }

    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}
