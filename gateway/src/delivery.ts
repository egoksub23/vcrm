// ============================================================
// How a message from Halo reaches the user, and when the gateway alerts them instead.
//
// The owner's decision (3 Oct 2026): the gateway alone chooses between the live connection and a push,
// and raises the push by calling the Vircle push API with the user's phone or email.
//
// For each message from Halo, once it is stored:
//
//   user has a live connection   send it on the connection, answer `socket`. The app should acknowledge it
//                                (a `delivered` receipt) within PUSH_ACK_TIMEOUT_MS. If it does not, the app
//                                is probably suspended behind a socket that still looks open: the sweeper
//                                alerts the user anyway.
//   user has no connection       ask the push API to alert them now: `push` (accepted), `no_device` (the API
//                                does not know a device for them), or `queued` (no alert was raised: one is
//                                already outstanding, the API failed, or the gateway has neither a phone nor
//                                an email for the user). The message waits and is replayed on connect.
//
// ONE ALERT PER AWAY PERIOD. After an alert is raised for a conversation, further messages raise none until
// the user comes back (connects, sends, or acknowledges anything), or until PUSH_REALERT_HOURS pass, when one
// reminder is allowed. The alert text is generic (no message content) and carries a deep link to the
// conversation; alerts for one conversation share a collapse key so they replace one another on the phone.
//
// FAILURES. If the push API fails in a way a retry may fix, the alert is retried with growing waits (30 s,
// 1 min, 2 min ... up to 15 min, five tries), by the sweeper; a message still unacknowledged after
// PUSH_WINDOW_MINUTES raises no alert any more and simply waits for the user.
// ============================================================

import type { GatewayConfig } from './config'
import type { FileService } from './files'
import { deliverFrame } from './frames'
import type { Hub } from './hub'
import type { MockPushAdapter, PushAdapter } from './push'
import type { Delivery, Message, Store, Subject, Workspace } from './store'

export interface DeliveryOptions {
  /** Turns a file in a message into a link for the app. Without it the frame carries the stored `media` as it is. */
  files?: FileService | null
  now?: () => number
  log?: (level: 'info' | 'warn', message: string) => void
}

interface Alerted {
  delivery: Delivery
  /** True when the decision for these messages is made; false when the sweeper should try again later. */
  final: boolean
}

const MAX_PUSH_TRIES = 5
const BASE_RETRY_MS = 30_000
const MAX_RETRY_MS = 15 * 60_000
const SWEEP_BATCH = 500

export class DeliveryService {
  private timer: NodeJS.Timeout | null = null
  private sweeping: Promise<number> | null = null
  private stopped = false
  private readonly now: () => number
  private readonly files: FileService | null
  private readonly log: NonNullable<DeliveryOptions['log']>

  constructor(
    private readonly store: Store,
    private readonly hub: Hub,
    readonly push: PushAdapter,
    /** Where the alerts for simulator users go, whatever `push` is: a test user never causes a real alert. */
    readonly simulatedPush: MockPushAdapter,
    private readonly cfg: Pick<GatewayConfig, 'push'>,
    opts: DeliveryOptions = {},
  ) {
    this.now = opts.now ?? Date.now
    this.files = opts.files ?? null
    this.log = opts.log ?? ((level, message) => (level === 'warn' ? console.warn : console.log)(`[delivery] ${message}`))
  }

  /** Get a stored message from Halo to the user. Resolves with what the gateway did (contract section 4). */
  async deliverFromHalo(subject: Subject, message: Message): Promise<Delivery> {
    const reached = this.hub.send(subject.user.id, deliverFrame(message, this.files))
    if (reached > 0) {
      await this.store.setDelivery(message.id, 'socket')
      return 'socket'
    }
    const outcome = await this.alert(subject, message.id)
    if (outcome.final) await this.store.markPushChecked([message.id], new Date(this.now()))
    await this.store.setDelivery(message.id, outcome.delivery)
    return outcome.delivery
  }

  /**
   * Raise the alert for a conversation unless one is already outstanding. Never throws: a failure of the
   * push API is an outcome, not an error.
   */
  private async alert(subject: Subject, messageId: string): Promise<Alerted> {
    const { user, workspace, conversation } = subject
    const now = new Date(this.now())
    const logOutcome = (outcome: 'sent' | 'no_device' | 'failed' | 'skipped', detail: string | null = null) =>
      this.store.logPush({ workspaceId: workspace.id, conversationId: conversation.id, messageId, outcome, detail })

    if (!user.phone && !user.email) {
      await logOutcome('skipped', 'The user has neither a phone number nor an email, so the push API cannot be asked')
      return { delivery: 'queued', final: true }
    }

    const reminderBefore = new Date(now.getTime() - this.cfg.push.realertHours * 3_600_000)
    if (!(await this.store.claimAlert(conversation.id, now, reminderBefore))) {
      const state = await this.store.alertState(conversation.id)
      // A failed alert waiting for its retry time is not decided yet; an alert already outstanding is.
      if (state && !state.alert_open && state.push_retry_at && new Date(state.push_retry_at).getTime() > now.getTime()) {
        return { delivery: 'queued', final: false }
      }
      await logOutcome('skipped', 'An alert is already outstanding for this conversation')
      return { delivery: 'queued', final: true }
    }

    let result
    try {
      result = await (user.simulated ? this.simulatedPush : this.push).send({
        phone: user.phone,
        email: user.email,
        walletId: user.wallet_id,
        title: this.title(workspace),
        body: this.body(workspace),
        deepLink: this.deepLink(workspace, subject),
        collapseKey: conversation.id,
      })
    } catch (err) {
      result = { status: 'failed' as const, error: err instanceof Error ? err.message : String(err), retryable: true }
    }

    if (result.status === 'sent') {
      await this.store.alertSettled(conversation.id)
      await logOutcome('sent')
      return { delivery: 'push', final: true }
    }
    if (result.status === 'no_device') {
      // The claim stays: asking again for every message would not find a device either.
      await this.store.alertSettled(conversation.id)
      await logOutcome('no_device')
      return { delivery: 'no_device', final: true }
    }

    const state = await this.store.alertState(conversation.id)
    const tries = (state?.push_fail_count ?? 0) + 1
    const retry = result.retryable && tries < MAX_PUSH_TRIES
    const retryAt = retry ? new Date(now.getTime() + Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** (tries - 1))) : null
    await this.store.alertFailed(conversation.id, retryAt)
    await logOutcome('failed', result.error)
    this.log('warn', `push for conversation ${conversation.id} failed (${retry ? 'will retry' : 'giving up'}): ${result.error}`)
    return { delivery: 'queued', final: !retry }
  }

  // ----------------------------------------------------------
  // The sweeper: messages the app did not acknowledge, and alerts to retry
  // ----------------------------------------------------------

  start(): void {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => void this.sweep().catch((err) => this.log('warn', `sweep failed: ${err instanceof Error ? err.message : err}`)), this.cfg.push.sweepMs)
    this.timer.unref()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.sweeping?.catch(() => undefined)
  }

  /** One pass. Returns how many conversations were looked at. Passes never overlap. */
  sweep(): Promise<number> {
    if (this.sweeping) return this.sweeping
    this.sweeping = this.sweepOnce().finally(() => {
      this.sweeping = null
    })
    return this.sweeping
  }

  private async sweepOnce(): Promise<number> {
    const now = new Date(this.now())
    const notBefore = new Date(now.getTime() - this.cfg.push.windowMinutes * 60_000)
    const ackBefore = new Date(now.getTime() - this.cfg.push.ackTimeoutMs)
    await this.store.expireUnchecked(notBefore, now)
    const rows = await this.store.unackedMessages(ackBefore, notBefore, SWEEP_BATCH)

    const byConversation = new Map<string, string[]>()
    for (const r of rows) byConversation.set(r.conversation_id, [...(byConversation.get(r.conversation_id) ?? []), r.id])

    for (const [conversationId, ids] of byConversation) {
      if (this.stopped) break
      const subject = await this.store.subjectByConversation(conversationId)
      if (!subject) {
        await this.store.markPushChecked(ids, now)
        continue
      }
      const outcome = await this.alert(subject, ids[0]!)
      if (outcome.final) await this.store.markPushChecked(ids, new Date(this.now()))
    }
    return byConversation.size
  }

  // ----------------------------------------------------------
  // What the alert says: generic, never the message
  // ----------------------------------------------------------

  private settings(workspace: Workspace): { title?: string; body?: string; deep_link?: string } {
    return workspace.push_settings && typeof workspace.push_settings === 'object' ? (workspace.push_settings as Record<string, string>) : {}
  }
  private title(workspace: Workspace): string {
    return this.settings(workspace).title?.trim() || workspace.name
  }
  private body(workspace: Workspace): string {
    return this.settings(workspace).body?.trim() || 'You have a new message'
  }
  private deepLink(workspace: Workspace, subject: Subject): string {
    const template = this.settings(workspace).deep_link?.trim() || this.cfg.push.deepLinkTemplate
    return template
      .replaceAll('{conversation_id}', encodeURIComponent(subject.conversation.id))
      .replaceAll('{wallet_id}', encodeURIComponent(subject.user.wallet_id))
  }
}
