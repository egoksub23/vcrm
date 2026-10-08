// ============================================================
// /api/account/channels/email
//
//   GET    — connection status. Any member can read. Never returns
//            tokens, only { connected, mailbox_address, connected_at,
//            needs_reauth, status, enabled, inbox_enabled, send_problem }.
//   PATCH  — two independent switches, either or both (admin+):
//              { enabled }       the master pause (migration 097): nothing
//                                in, nothing out. Leaves the saved token
//                                and subscription untouched.
//              { inbox_enabled } use the mailbox for the customer care
//                                inbox (migration 179). Off deletes the Graph
//                                subscription (nothing new is ingested; the
//                                mailbox still sends Halo's own email), on
//                                creates a new one and ingests from then on.
//            Both are distinct from DELETE.
//   DELETE — disconnect. Admin+. Best-effort deletes the Graph
//            subscription too, so Microsoft stops billing/tracking a
//            notification target that no longer has anywhere to go.
// ============================================================
import { NextResponse } from 'next/server'

import { getCurrentAccount, requireCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { mailboxSendProblem } from '@/lib/email/mailbox-types'
import { getValidAccessToken } from '@/lib/ms365/token'
import { deleteSubscription } from '@/lib/ms365/mail-api'
import { realInboxSwitchDeps, setMs365Inbox } from '@/lib/ms365/inbox-switch'
import { getOAuthBaseUrl } from '@/lib/ms365/oauth'
import type { EmailConnectionStatus } from '@/types'

export async function GET() {
  try {
    const ctx = await getCurrentAccount()

    const { data, error } = await ctx.supabase
      .from('email_config')
      .select('mailbox_address, connected_at, needs_reauth, status, enabled, inbox_enabled')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (error) {
      console.error('[GET /api/account/channels/email] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load Email connection' }, { status: 500 })
    }

    const result: EmailConnectionStatus = data
      ? {
          connected: true,
          mailbox_address: data.mailbox_address,
          connected_at: data.connected_at,
          needs_reauth: data.needs_reauth,
          status: data.status,
          enabled: data.enabled,
          inbox_enabled: data.inbox_enabled,
          // whether Halo can send its own email through the mailbox (Secure Sign, invitations, notifications): the inbox switch plays no part
          send_problem: mailboxSendProblem(data),
        }
      : { connected: false, needs_reauth: false, status: 'disconnected' }

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
      .from('email_config')
      .select('*')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (config?.subscription_id) {
      try {
        const accessToken = await getValidAccessToken(config)
        await deleteSubscription({ accessToken, subscriptionId: config.subscription_id })
      } catch (err) {
        // Best-effort — a dead/expired token means Graph's side has
        // likely already dropped the subscription itself. Never block
        // the local disconnect on this.
        console.warn(
          '[DELETE /api/account/channels/email] subscription delete failed (continuing):',
          err instanceof Error ? err.message : err,
        )
      }
    }

    const { error } = await ctx.supabase
      .from('email_config')
      .delete()
      .eq('account_id', ctx.accountId)

    if (error) {
      console.error('[DELETE /api/account/channels/email] delete error:', error)
      return NextResponse.json({ error: 'Failed to disconnect Email' }, { status: 500 })
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
        .from('email_config')
        .update({ enabled: body!.enabled })
        .eq('account_id', ctx.accountId)

      if (error) {
        console.error('[PATCH /api/account/channels/email] update error:', error)
        return NextResponse.json({ error: 'Failed to update Email' }, { status: 500 })
      }
      result.enabled = body!.enabled
    }

    if (wantsInbox) {
      // The flag is written as the signed-in person (so the audit trail names them); the subscription is the service role's.
      const outcome = await setMs365Inbox(
        { accountId: ctx.accountId, enabled: body!.inbox_enabled as boolean, baseUrl: getOAuthBaseUrl(request) },
        realInboxSwitchDeps(async (accountId, value) => {
          const { error } = await ctx.supabase.from('email_config').update({ inbox_enabled: value }).eq('account_id', accountId)
          return error ? { message: error.message } : null
        }),
      )
      if (!outcome.ok) {
        return NextResponse.json({ error: outcome.error, code: outcome.code }, { status: outcome.status })
      }
      result.inbox_enabled = outcome.inbox_enabled
      result.subscription = outcome.subscription
    }

    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}
