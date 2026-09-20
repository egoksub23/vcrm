// ============================================================
// /api/account/channels/email
//
//   GET    — connection status. Any member can read. Never returns
//            tokens, only { connected, mailbox_address, connected_at,
//            needs_reauth, status }.
//   DELETE — disconnect. Admin+. Best-effort deletes the Graph
//            subscription too, so Microsoft stops billing/tracking a
//            notification target that no longer has anywhere to go.
// ============================================================
import { NextResponse } from 'next/server'

import { getCurrentAccount, requireCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getValidAccessToken } from '@/lib/ms365/token'
import { deleteSubscription } from '@/lib/ms365/mail-api'
import type { EmailConnectionStatus } from '@/types'

export async function GET() {
  try {
    const ctx = await getCurrentAccount()

    const { data, error } = await ctx.supabase
      .from('email_config')
      .select('mailbox_address, connected_at, needs_reauth, status')
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
