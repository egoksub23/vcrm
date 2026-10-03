// ============================================================
// Sends the outbox to Halo (docs/vircle-chat-contract.md, section 3).
//
// Every `message.inbound` and `message.receipt` the gateway wants Halo to know is a row in
// `outbox_events`, written in the same transaction as the change itself. This dispatcher posts
// them, signed, and marks each one done only when Halo answers 2xx.
//
// Rules:
//   * ORDER. A workspace's events go in the order they were written. An event waiting for a retry
//     holds back the ones behind it, so Halo never sees a reply before the message it answers.
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

export interface DispatcherOptions {
  /** Replaceable in tests. */
  fetch?: typeof fetch
  now?: () => number
  random?: () => number
  log?: (level: 'info' | 'warn', message: string) => void
}

export interface RunSummary {
  sent: number
  retrying: number
  failed: number
}

type Outcome = { kind: 'ok' } | { kind: 'retry'; error: string; retryAfterMs: number | null } | { kind: 'dead'; error: string }

/** Statuses meaning "Halo read this and refuses it": nothing a retry can fix. */
const FINAL_STATUSES = new Set([400, 413, 422])
/** The most events sent for one workspace in one pass, so one busy workspace cannot starve the rest. */
const MAX_PER_PASS = 200

export class Dispatcher {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<RunSummary> | null = null
  private again = false
  private stopped = false

  private readonly doFetch: typeof fetch
  private readonly now: () => number
  private readonly random: () => number
  private readonly log: NonNullable<DispatcherOptions['log']>

  constructor(
    private readonly store: Store,
    private readonly cfg: Pick<GatewayConfig, 'dispatch'>,
    opts: DispatcherOptions = {},
  ) {
    this.doFetch = opts.fetch ?? fetch
    this.now = opts.now ?? Date.now
    this.random = opts.random ?? Math.random
    this.log = opts.log ?? ((level, message) => (level === 'warn' ? console.warn : console.log)(`[dispatcher] ${message}`))
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

    for (let i = 0; i < MAX_PER_PASS && !this.stopped; i++) {
      const event = await this.store.nextEvent(workspaceId)
      if (!event) break
      // The head of the queue is waiting out a retry: everything behind it waits too.
      if (new Date(event.next_attempt_at).getTime() > this.now()) break

      const outcome = await this.deliver(workspace, event)
      if (outcome.kind === 'ok') {
        await this.store.markDispatched(event.id)
        summary.sent++
        continue
      }
      if (outcome.kind === 'dead') {
        await this.store.markFailed(event.id, outcome.error)
        this.log('warn', `event ${event.id} (${event.kind}) refused by Halo for good: ${outcome.error}`)
        summary.failed++
        continue
      }
      const ageHours = (this.now() - new Date(event.created_at).getTime()) / 3_600_000
      if (ageHours >= this.cfg.dispatch.giveUpHours) {
        await this.store.markFailed(event.id, `Given up after ${this.cfg.dispatch.giveUpHours} hours: ${outcome.error}`)
        this.log('warn', `event ${event.id} (${event.kind}) given up after ${Math.round(ageHours)} hours: ${outcome.error}`)
        summary.failed++
        continue
      }
      await this.store.markRetry(event.id, new Date(this.now() + this.backoffMs(event.attempts, outcome.retryAfterMs)), outcome.error)
      if (event.attempts === 0) this.log('warn', `event ${event.id} (${event.kind}) not accepted by Halo, will retry: ${outcome.error}`)
      summary.retrying++
      break
    }
    return summary
  }

  /** 2 s, 4 s, 8 s ... up to the cap, plus or minus a fifth; Retry-After wins when it asks for longer. */
  backoffMs(attempts: number, retryAfterMs: number | null): number {
    const cap = this.cfg.dispatch.maxBackoffMs
    const base = Math.min(cap, 2000 * 2 ** Math.min(attempts, 20))
    const jittered = base * (0.8 + this.random() * 0.4)
    return Math.min(cap, Math.max(jittered, retryAfterMs ?? 0))
  }

  private async deliver(workspace: Workspace, event: OutboxEvent): Promise<Outcome> {
    const rawBody = JSON.stringify(event.payload)
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

    if (res.status >= 200 && res.status < 300) return { kind: 'ok' }
    const error = `Halo answered ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`
    if (FINAL_STATUSES.has(res.status)) return { kind: 'dead', error }
    const retryAfter = Number(res.headers.get('retry-after'))
    return { kind: 'retry', error, retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null }
  }
}
