import { inboxIsOff } from '@/lib/email/mailbox-types'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getCurrentHistoryId, stopWatch, watchMailbox } from '@/lib/gmail/gmail-api'
import { getValidAccessToken, type GmailConfigRow } from '@/lib/gmail/token'

/**
 * Switching a Gmail mailbox on or off as the customer care inbox (`gmail_config.inbox_enabled`, migration 179). The switch is independent of the
 * mailbox's master pause (`enabled`) and of Halo's use of the mailbox as a sender. The Gmail mirror of lib/ms365/inbox-switch.ts.
 *
 * OFF
 *   1. the flag is written first, so the webhook drops anything that still arrives from this moment;
 *   2. Gmail's push watch is stopped (`users.stop`: Google stops publishing this mailbox's changes to the Pub/Sub topic) and watch_expiration is
 *      cleared, so the watch-renew job has nothing to do for this mailbox. history_id is left alone.
 *   If Google does not confirm the stop the inbox is still off: the webhook drops the pushes and the watch lapses by itself within a week.
 *
 * ON
 *   The mailbox must be connected and not need reconnecting. A new watch is registered with the existing code (watchMailbox) when the deployment has a
 *   Pub/Sub topic. The history baseline (history_id) is moved to NOW, whatever it was: mail that arrived while the inbox was off is not fetched
 *   (Gmail's history list from the old baseline would otherwise replay all of it). Then the flag is written.
 *
 * The flag itself is written by the caller's own client (`setFlag`), as the person who asked, so the audit trail credits them; the watch columns are
 * written by the service role.
 */

export interface GmailInboxRow extends GmailConfigRow {
  status?: string | null
  needs_reauth?: boolean | null
  inbox_enabled?: boolean | null
  history_id?: string | null
  watch_expiration?: string | null
}

export interface GmailInboxDeps {
  loadConfig: (accountId: string) => Promise<GmailInboxRow | null>
  /** Write inbox_enabled as the person who asked (audited). */
  setFlag: (accountId: string, enabled: boolean) => Promise<{ message: string } | null>
  /** Service-role write of the watch columns. An error here is reported by the caller, never thrown. */
  saveWatch: (configId: string, patch: Record<string, unknown>) => Promise<{ message: string } | null>
  getAccessToken: (config: GmailInboxRow) => Promise<string>
  stopWatch: (args: { accessToken: string }) => Promise<boolean>
  watchMailbox: typeof watchMailbox
  getCurrentHistoryId: typeof getCurrentHistoryId
  /** The deployment's Pub/Sub topic (GMAIL_PUBSUB_TOPIC); without it Gmail cannot push and no watch is registered. */
  pubsubTopic: () => string | null
}

export type GmailInboxSwitchResult =
  | { ok: true; inbox_enabled: boolean; watch: 'started' | 'stopped' | 'stop_failed' | 'not_configured' | 'unchanged' }
  | { ok: false; status: 404 | 409 | 500 | 502; code: 'not_connected' | 'needs_reconnect' | 'watch_failed' | 'save_failed'; error: string }

export function realGmailInboxDeps(setFlag: GmailInboxDeps['setFlag']): GmailInboxDeps {
  return {
    loadConfig: async (accountId) => {
      const { data } = await supabaseAdmin().from('gmail_config').select('*').eq('account_id', accountId).maybeSingle()
      return (data as GmailInboxRow | null) ?? null
    },
    setFlag,
    saveWatch: async (configId, patch) => {
      const { error } = await supabaseAdmin().from('gmail_config').update(patch).eq('id', configId)
      return error ? { message: error.message } : null
    },
    getAccessToken: (config) => getValidAccessToken(config),
    stopWatch,
    watchMailbox,
    getCurrentHistoryId,
    pubsubTopic: () => process.env.GMAIL_PUBSUB_TOPIC?.trim() || null,
  }
}

export async function setGmailInbox(args: { accountId: string; enabled: boolean }, deps: GmailInboxDeps): Promise<GmailInboxSwitchResult> {
  const config = await deps.loadConfig(args.accountId)
  if (!config) return { ok: false, status: 404, code: 'not_connected', error: 'Gmail is not connected. Connect it in Settings > Channels first.' }

  if (!args.enabled) {
    const flagError = await deps.setFlag(args.accountId, false)
    if (flagError) return { ok: false, status: 500, code: 'save_failed', error: 'Could not switch the Gmail inbox off.' }

    let stopped = true
    const hadWatch = !!config.watch_expiration
    try {
      stopped = await deps.stopWatch({ accessToken: await deps.getAccessToken(config) })
    } catch (err) {
      stopped = false
      console.warn('[gmail inbox off] could not stop the watch (the inbox is off anyway):', err instanceof Error ? err.message : err)
    }
    await deps.saveWatch(config.id, { watch_expiration: null })
    return { ok: true, inbox_enabled: false, watch: hadWatch ? (stopped ? 'stopped' : 'stop_failed') : 'unchanged' }
  }

  // ON
  // already on: nothing to do, and above all the history baseline must not move (that would skip the mail received since the last push)
  if (!inboxIsOff(config)) return { ok: true, inbox_enabled: true, watch: 'unchanged' }
  if (config.status && config.status !== 'connected') {
    return { ok: false, status: 409, code: 'needs_reconnect', error: 'Reconnect the mailbox first, then switch the Gmail inbox on.' }
  }
  if (config.needs_reauth === true) {
    return { ok: false, status: 409, code: 'needs_reconnect', error: 'Reconnect the mailbox first (its Google access expired or was revoked), then switch the Gmail inbox on.' }
  }

  const topic = deps.pubsubTopic()
  let accessToken: string
  let patch: Record<string, unknown>
  let watch: 'started' | 'not_configured'
  try {
    accessToken = await deps.getAccessToken(config)
    if (topic) {
      const w = await deps.watchMailbox({ accessToken, topicName: topic })
      // the watch's own historyId is "now"
      patch = { watch_expiration: w.expiration, history_id: w.historyId }
      watch = 'started'
    } else {
      patch = { watch_expiration: null, history_id: await deps.getCurrentHistoryId({ accessToken }).catch(() => null) }
      watch = 'not_configured'
    }
  } catch (err) {
    console.error('[gmail inbox on] could not start the watch:', err instanceof Error ? err.message : err)
    return { ok: false, status: 502, code: 'watch_failed', error: 'Could not start receiving email from Gmail. Try again, or reconnect the mailbox.' }
  }

  const saved = await deps.saveWatch(config.id, patch)
  if (saved) return { ok: false, status: 500, code: 'save_failed', error: 'Could not switch the Gmail inbox on.' }
  const flagError = await deps.setFlag(args.accountId, true)
  if (flagError) {
    if (watch === 'started') {
      await deps.stopWatch({ accessToken }).catch(() => false)
      await deps.saveWatch(config.id, { watch_expiration: null })
    }
    return { ok: false, status: 500, code: 'save_failed', error: 'Could not switch the Gmail inbox on.' }
  }
  return { ok: true, inbox_enabled: true, watch }
}
