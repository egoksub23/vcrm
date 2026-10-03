// ============================================================
// Sends the outbox to Halo (docs/vircle-chat-contract.md, section 3).
//
// Every `message.inbound` and `message.receipt` the gateway wants Halo to know is a row in
// `outbox_events`, written in the same transaction as the change itself. This dispatcher posts
// them, signed, and marks each one done only when Halo answers 2xx.
//
// Rules:
//   * ORDER. A conversation's events go in the order they were written. An event waiting for a retry
//     holds back the ones behind it in the same conversation, so Halo never sees a reply before the message it
//     answers. Different conversations are sent side by side (DISPATCH_CONCURRENCY at a time): a slow Halo
//     would otherwise cap the whole gateway at one event per round trip.
//   * RETRY. Anything that might clear up (no answer, 5xx, 429, a wrong signature while someone is
//     fixing the secret) is retried with growing waits and a little jitter, honouring Retry-After.
//     After `giveUpHours` an event is given up on and kept, with its error, for inspection.
//   * FINAL. A 400, 413 or 422 means Halo read the event and refused it; resending cannot help, so
//     the event is set aside and the ones behind it carry on.
//   * REPEATS ARE SAFE. Halo remembers event ids, so a retry after a lost answer does nothing twice.
//   * ONE PROCESS. A single gateway instance runs this loop; running two would send some events
//     twice (harmless, Halo dedupes) but could reorder them.
// ============================================================

import type { GatewayConfig } from './config'
import { signedHeaders } from './signing'
import type { OutboxEvent, Store, Workspace } from './store'
import { log } from './log'

export interface DispatcherOptions {
  /** Replaceable in tests. */
  fetch?: typeof fetch
  now?: () => number
  random?: () => number
  log?: (level: 'info' | 'warn', message: string) => void
  /**
   * Last touch on the payload before it is signed and sent: the gateway uses it to turn a stored file into a
   * fresh link (so an event retried hours later still has a good one).
   */
  transformPayload?: (payload: Record<string, unknown>) => Record<string, unknown>
  /** Halo accepted an event (2xx). The gateway uses it to mark the user's message `delivered` and tell the app. */
  onDispatched?: (event: OutboxEvent) => Promise<void>
}

export interface RunSummary {
  sent: number
  retrying: number
  failed: number
}

/** `status` and `detail` are what Halo answered (absent when it could not be reached); the simulator shows them. */
export type Outcome =
  | { kind: 'ok'; status?: number; detail?: string }
  | { kind: 'retry'; error: string; retryAfterMs: number | null; status?: number }
  | { kind: 'dead'; error: string; status?: number }

/** Statuses meaning "Halo read this and refuses it": nothing a retry can fix. */
const FINAL_STATUSES = new Set([400, 413, 422])
/** The most events sent for one workspace in one pass, so one busy workspace cannot starve the rest. */
const MAX_PER_PASS = 1000
/** Conversations looked at in one pass. */
const MAX_LANES_PER_PASS = 500
/** After this many events Halo did not accept in one pass, the pass stops: Halo is struggling, wait for the backoff. */
const MAX_FAILURES_PER_PASS = 3

export class Dispatcher {
  private timer: NodeJS.Timeout | null = null
  /** True when a test supplied its own clock; otherwise "due" is decided by the database's clock. */
  private readonly injectedClock: boolean
  private running: Promise<RunSummary> | null = null
  private again = false
  private stopped = false

  private readonly doFetch: typeof fetch
  private readonly now: () => number
  private readonly random: () => number
  private readonly log: NonNullable<DispatcherOptions['log']>
  private readonly transformPayload: (payload: Record<string, unknown>) => Record<string, unknown>
  private readonly onDispatched: ((event: OutboxEvent) => Promise<void>) | null

  constructor(
    private readonly store: Store,
    private readonly cfg: Pick<GatewayConfig, 'dispatch'>,
    opts: DispatcherOptions = {},
  ) {
    this.doFetch = opts.fetch ?? fetch
    this.now = opts.now ?? Date.now
    this.injectedClock = opts.now !== undefined
    this.random = opts.random ?? Math.random
    this.transformPayload = opts.transformPayload ?? ((p) => p)
    this.onDispatched = opts.onDispatched ?? null
    const logger = log.child('dispatcher')
    this.log = opts.log ?? ((level, message) => logger[level === 'warn' ? 'warn' : 'info'](message))
  }

  start(): void {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => void this.runOnce().catch(() => undefined), this.cfg.dispatch.pollMs)
    this.timer.unref()
    this.kick()
  }

  /** Something was just written to the outbox: look now instead of at the next poll. */
  kick(): void {
    if (this.stopped) return
    setImmediate(() => void this.runOnce().catch((err) => this.log('warn', `run failed: ${err instanceof Error ? err.message : err}`)))
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.running?.catch(() => undefined)
  }

  /** One pass over every workspace with something waiting. Passes never overlap; a request during one asks for another straight after. */
  runOnce(): Promise<RunSummary> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      const total: RunSummary = { sent: 0, retrying: 0, failed: 0 }
      try {
        do {
          this.again = false
          const ids = await this.store.workspacesWithPendingEvents()
          const parts = await Promise.all(ids.map((id) => this.drain(id)))
          for (const p of parts) {
            total.sent += p.sent
            total.retrying += p.retrying
            total.failed += p.failed
          }
        } while (this.again && !this.stopped)
        return total
      } finally {
        this.running = null
      }
    })()
    return this.running
  }

  private async drain(workspaceId: string): Promise<RunSummary> {
    const summary: RunSummary = { sent: 0, retrying: 0, failed: 0 }
    const workspace = await this.store.getWorkspaceById(workspaceId)
    if (!workspace) return summary

    const nowIso = this.injectedClock ? new Date(this.now()).toISOString() : null
    const heads = await this.store.dueLaneHeads(workspaceId, nowIso, MAX_LANES_PER_PASS)
    if (heads.length >= MAX_LANES_PER_PASS) this.again = true
    let budget = MAX_PER_PASS
    let nextHead = 0
    let halted = false

    // `concurrency` workers each take a conversation and send its events in order until it has none due, or one is not accepted.
    const worker = async (): Promise<void> => {
      while (!halted && !this.stopped) {
        const head = heads[nextHead++]
        if (!head) return
        let event: OutboxEvent | null = head
        while (event && !halted && !this.stopped && budget-- > 0) {
          const outcome = await this.deliver(workspace, event)
          if (outcome.kind === 'ok') {
            await this.store.markDispatched(event.id)
            await this.onDispatched?.(event).catch((err) => this.log('warn', `after-dispatch step failed for ${event!.id}: ${err instanceof Error ? err.message : err}`))
            summary.sent++
          } else if (outcome.kind === 'dead') {
            await this.store.markFailed(event.id, outcome.error)
            this.log('warn', `event ${event.id} (${event.kind}) refused by Halo for good: ${outcome.error}`)
            summary.failed++
          } else {
            const ageHours = (this.now() - new Date(event.created_at).getTime()) / 3_600_000
            if (ageHours >= this.cfg.dispatch.giveUpHours) {
              await this.store.markFailed(event.id, `Given up after ${this.cfg.dispatch.giveUpHours} hours: ${outcome.error}`)
              this.log('warn', `event ${event.id} (${event.kind}) given up after ${Math.round(ageHours)} hours: ${outcome.error}`)
              summary.failed++
            } else {
              await this.store.markRetry(event.id, new Date(this.now() + this.backoffMs(event.attempts, outcome.retryAfterMs)), outcome.error)
              if (event.attempts === 0) this.log('warn', `event ${event.id} (${event.kind}) not accepted by Halo, will retry: ${outcome.error}`)
              summary.retrying++
              // This conversation waits out the retry; so does the whole pass once Halo keeps refusing.
              if (summary.retrying >= MAX_FAILURES_PER_PASS) halted = true
              break
            }
          }
          // The next event of the same conversation, if it is due.
          const following: (OutboxEvent & { due: boolean }) | null = await this.store.nextEventInLane(workspaceId, event.conversation_id ?? null, nowIso)
          event = following?.due ? following : null
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.cfg.dispatch.concurrency, heads.length) }, () => worker()))
    if (budget <= 0) this.again = true
    return summary
  }

  /** 2 s, 4 s, 8 s ... up to the cap, plus or minus a fifth; Retry-After wins when it asks for longer. */
  backoffMs(attempts: number, retryAfterMs: number | null): number {
    const cap = this.cfg.dispatch.maxBackoffMs
    const base = Math.min(cap, 2000 * 2 ** Math.min(attempts, 20))
    const jittered = base * (0.8 + this.random() * 0.4)
    return Math.min(cap, Math.max(jittered, retryAfterMs ?? 0))
  }

  /**
   * Tell Halo something that is only worth knowing now (the user is typing): one signed post, no outbox, no
   * retry, never throws. Returns whether Halo accepted it.
   */
  async sendEphemeral(workspace: Workspace, payload: Record<string, unknown>): Promise<boolean> {
    try {
      const rawBody = JSON.stringify(payload)
      const res = await this.doFetch(workspace.halo_webhook_url, {
        method: 'POST',
        headers: signedHeaders(this.store.haloSigningSecret(workspace), rawBody, this.now()),
        body: rawBody,
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.min(this.cfg.dispatch.timeoutMs, 5000)),
      })
      await res.body?.cancel().catch(() => undefined)
      return res.status >= 200 && res.status < 300
    } catch {
      return false
    }
  }

  /**
   * Post an event again, freshly signed, WITHOUT touching its state in the outbox. For the simulator's
   * "replay an old event": Halo must answer a repeat with 200 and no effect (it remembers event ids).
   */
  async replay(workspace: Workspace, event: OutboxEvent): Promise<Outcome> {
    return this.deliver(workspace, event)
  }

  private async deliver(workspace: Workspace, event: OutboxEvent): Promise<Outcome> {
    const rawBody = JSON.stringify(this.transformPayload(event.payload))
    let secret: string
    try {
      secret = this.store.haloSigningSecret(workspace)
    } catch {
      return { kind: 'retry', error: 'The stored signing secret cannot be decrypted (check GATEWAY_ENCRYPTION_KEY)', retryAfterMs: null }
    }

    let res: Response
    try {
      res = await this.doFetch(workspace.halo_webhook_url, {
        method: 'POST',
        headers: signedHeaders(secret, rawBody, this.now()),
        body: rawBody,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.cfg.dispatch.timeoutMs),
      })
    } catch (err) {
      const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'could not be reached'
      return { kind: 'retry', error: `Halo ${reason}`, retryAfterMs: null }
    }
    // Free the connection; the body of a success carries nothing the gateway needs.
    const detail = await res.text().catch(() => '')

    if (res.status >= 200 && res.status < 300) return { kind: 'ok', status: res.status, detail: detail.slice(0, 300) }
    const error = `Halo answered ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`
    if (FINAL_STATUSES.has(res.status)) return { kind: 'dead', error, status: res.status }
    const retryAfter = Number(res.headers.get('retry-after'))
    return { kind: 'retry', error, retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null, status: res.status }
  }
}
