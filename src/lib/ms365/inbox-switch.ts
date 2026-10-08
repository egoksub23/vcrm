import type { SupabaseClient } from '@supabase/supabase-js'

import { inboxIsOff } from '@/lib/email/mailbox-types'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { deleteSubscription } from '@/lib/ms365/mail-api'
import { renewMailboxSubscription } from '@/lib/ms365/subscription-renewal'
import { getValidAccessToken, type EmailConfigRow } from '@/lib/ms365/token'

/**
 * Switching a Microsoft 365 mailbox on or off as the customer care inbox (`email_config.inbox_enabled`, migration 179). The switch is independent of
 * the mailbox's master pause (`enabled`) and of Halo's use of the mailbox as a sender.
 *
 * OFF
 *   1. the flag is written first, so the webhook drops anything that still arrives from this moment;
 *   2. the Graph change-notification subscription is deleted (Halo stops being called, and stops renewing it);
 *   3. subscription_id / subscription_expires_at / subscription_notification_url are cleared, so the renewal job and the heartbeat have nothing to do
 *      for this mailbox and nothing looks lapsed.
 *   If Graph does not confirm the delete (the token is dead, Graph is down) the inbox is still off: the webhook drops the mail and the subscription
 *   lapses by itself within about 3 days. The result says so (`stop_failed`).
 *
 * ON
 *   The mailbox must be connected and not need reconnecting. A new subscription is created with the existing renewal code (renewMailboxSubscription:
 *   there is no subscription_id, so it creates one) and only then is the flag written, so the switch never claims an inbox that is not listening. A
 *   Graph change notification covers mail that arrives after the subscription exists: nothing received while the inbox was off is fetched.
 *
 * The flag itself is written by the caller's own client (`setFlag`), as the person who asked, so the audit trail credits them; the subscription
 * columns are written by the service role.
 */

export interface InboxRow extends EmailConfigRow {
  subscription_id: string | null
  client_state: string
  subscription_notification_url?: string | null
  status?: string | null
  needs_reauth?: boolean | null
  inbox_enabled?: boolean | null
}

export interface InboxSwitchDeps {
  loadConfig: (accountId: string) => Promise<InboxRow | null>
  /** Write inbox_enabled as the person who asked (audited). */
  setFlag: (accountId: string, enabled: boolean) => Promise<{ message: string } | null>
  /** Service-role write of the subscription columns. An error here is reported by the caller, never thrown. */
  saveSubscription: (configId: string, patch: Record<string, unknown>) => Promise<{ message: string } | null>
  getAccessToken: (config: InboxRow) => Promise<string>
  deleteSubscription: (args: { accessToken: string; subscriptionId: string }) => Promise<boolean>
  /** Create (or renew) the subscription and persist it: the existing renewal code. */
  startSubscription: (config: InboxRow, baseUrl: string) => Promise<void>
}

export type InboxSwitchResult =
  | { ok: true; inbox_enabled: boolean; subscription: 'started' | 'stopped' | 'stop_failed' | 'unchanged' }
  | { ok: false; status: 404 | 409 | 500 | 502; code: 'not_connected' | 'needs_reconnect' | 'subscription_failed' | 'save_failed'; error: string }

export function realInboxSwitchDeps(setFlag: InboxSwitchDeps['setFlag']): InboxSwitchDeps {
  return {
    loadConfig: async (accountId) => {
      const { data } = await supabaseAdmin().from('email_config').select('*').eq('account_id', accountId).maybeSingle()
      return (data as InboxRow | null) ?? null
    },
    setFlag,
    saveSubscription: async (configId, patch) => {
      const { error } = await supabaseAdmin().from('email_config').update(patch).eq('id', configId)
      return error ? { message: error.message } : null
    },
    getAccessToken: (config) => getValidAccessToken(config),
    deleteSubscription,
    startSubscription: async (config, baseUrl) => {
      await renewMailboxSubscription({ admin: supabaseAdmin() as SupabaseClient, config, baseUrl })
    },
  }
}

/** What an empty subscription looks like on the row. */
const NO_SUBSCRIPTION = { subscription_id: null, subscription_expires_at: null, subscription_notification_url: null }

export async function setMs365Inbox(args: { accountId: string; enabled: boolean; baseUrl: string }, deps: InboxSwitchDeps): Promise<InboxSwitchResult> {
  const config = await deps.loadConfig(args.accountId)
  if (!config) return { ok: false, status: 404, code: 'not_connected', error: 'Email is not connected. Connect it in Settings > Channels first.' }

  if (!args.enabled) {
    const flagError = await deps.setFlag(args.accountId, false)
    if (flagError) return { ok: false, status: 500, code: 'save_failed', error: 'Could not switch the email inbox off.' }

    let stopped = true
    if (config.subscription_id) {
      try {
        const accessToken = await deps.getAccessToken(config)
        stopped = await deps.deleteSubscription({ accessToken, subscriptionId: config.subscription_id })
      } catch (err) {
        stopped = false
        console.warn('[email inbox off] could not delete the Graph subscription (the inbox is off anyway):', err instanceof Error ? err.message : err)
      }
    }
    // Before migration 156 the notification-address column does not exist: clear what is there.
    const cleared = await deps.saveSubscription(config.id, NO_SUBSCRIPTION)
    if (cleared) {
      await deps.saveSubscription(config.id, { subscription_id: null, subscription_expires_at: null })
    }
    return { ok: true, inbox_enabled: false, subscription: config.subscription_id ? (stopped ? 'stopped' : 'stop_failed') : 'unchanged' }
  }

  // ON
  if (config.status && config.status !== 'connected') {
    return { ok: false, status: 409, code: 'needs_reconnect', error: 'Reconnect the mailbox first, then switch the email inbox on.' }
  }
  if (config.needs_reauth === true) {
    return { ok: false, status: 409, code: 'needs_reconnect', error: 'Reconnect the mailbox first (its Microsoft access expired or was revoked), then switch the email inbox on.' }
  }
  if (!inboxIsOff(config) && config.subscription_id) {
    return { ok: true, inbox_enabled: true, subscription: 'unchanged' }
  }

  try {
    await deps.startSubscription({ ...config, subscription_id: null }, args.baseUrl)
  } catch (err) {
    console.error('[email inbox on] could not create the Graph subscription:', err instanceof Error ? err.message : err)
    return { ok: false, status: 502, code: 'subscription_failed', error: 'Could not start receiving email from Microsoft 365. Try again, or reconnect the mailbox.' }
  }

  const flagError = await deps.setFlag(args.accountId, true)
  if (flagError) {
    // do not leave a listening subscription behind an inbox that says it is off
    const fresh = await deps.loadConfig(args.accountId).catch(() => null)
    if (fresh?.subscription_id) {
      try {
        await deps.deleteSubscription({ accessToken: await deps.getAccessToken(fresh), subscriptionId: fresh.subscription_id })
      } catch {
        // it lapses by itself
      }
      await deps.saveSubscription(fresh.id, NO_SUBSCRIPTION)
    }
    return { ok: false, status: 500, code: 'save_failed', error: 'Could not switch the email inbox on.' }
  }
  return { ok: true, inbox_enabled: true, subscription: 'started' }
}
