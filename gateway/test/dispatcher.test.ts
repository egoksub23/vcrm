import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { testConfig } from '../src/config'
import type { Db } from '../src/db'
import { Dispatcher } from '../src/dispatcher'
import { signBody } from '../src/signing'
import { Store, type Subject, type Workspace } from '../src/store'
import { createTestDb, WORKSPACE } from './helpers'

interface Call {
  url: string
  headers: Record<string, string>
  body: string
  json: Record<string, unknown>
}

let db: Db
let store: Store
let workspace: Workspace
let subject: Subject
let calls: Call[]
/** What the pretend Halo answers, one entry per call; the last repeats. */
let answers: (Response | Error)[]
/** Milliseconds added to the real clock; a test moves time forward by raising it. */
let skew: number
const now = () => Date.now() + skew
let dispatcher: Dispatcher
const cfg = testConfig()

const respond = (status: number, body: unknown = { ok: true }, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

function makeDispatcher(overrides: Partial<typeof cfg.dispatch> = {}) {
  return new Dispatcher(
    store,
    { dispatch: { ...cfg.dispatch, ...overrides } },
    {
      fetch: (async (url: string, init: RequestInit) => {
        const body = String(init.body)
        calls.push({ url, headers: init.headers as Record<string, string>, body, json: JSON.parse(body) })
        const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!
        if (answer instanceof Error) throw answer
        return answer.clone()
      }) as unknown as typeof fetch,
      now,
      random: () => 0.5, // no jitter, so waits are exact
      log: () => undefined,
    },
  )
}

beforeEach(async () => {
  db = await createTestDb()
  store = new Store(db, cfg)
  workspace = (await store.createWorkspace(WORKSPACE)).workspace
  subject = await store.upsertUser(workspace, { walletId: 'W-d', name: 'Aisha', phone: '+60123456789', email: 'a@example.com' })
  calls = []
  answers = [respond(200)]
  skew = 0
  dispatcher = makeDispatcher()
})
afterEach(async () => {
  await dispatcher.stop()
  await db.close()
})

const inbound = (n: number) => store.appendInbound(subject, { clientId: `c${n}`, type: 'text', text: `message ${n}` })
const pendingTexts = async () =>
  (await store.pendingEvents(workspace.id)).map((e) => ((e.payload as { message?: { text?: string } }).message?.text ?? (e.payload as { server_id?: string }).server_id) as string)

describe('sending an event', () => {
  it('posts it to Halo\'s address, signed so Halo\'s own check accepts it, and marks it done', async () => {
    await inbound(1)
    expect(await dispatcher.runOnce()).toEqual({ sent: 1, retrying: 0, failed: 0 })
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe(workspace.halo_webhook_url)
    expect(call.json).toMatchObject({ event: 'message.inbound', workspace_key: workspace.workspace_key, user: { wallet_id: 'W-d' }, message: { text: 'message 1' } })
    // the signature covers exactly the bytes sent, with the workspace's secret
    expect(call.headers['x-vircle-signature']).toBe(signBody(WORKSPACE.signingSecret, call.headers['x-vircle-timestamp']!, call.body))
    expect(call.headers['content-type']).toBe('application/json')
    expect(await store.pendingEvents(workspace.id)).toEqual([])
    expect(await store.outboxStats()).toMatchObject({ pending: 0, failed: 0 })
  })

  it('counts "ignored: paused" as accepted, since Halo meant it', async () => {
    answers = [respond(200, { ok: true, ignored: 'paused' })]
    await inbound(1)
    expect((await dispatcher.runOnce()).sent).toBe(1)
    expect(await store.pendingEvents(workspace.id)).toEqual([])
  })

  it('does nothing when there is nothing to send', async () => {
    expect(await dispatcher.runOnce()).toEqual({ sent: 0, retrying: 0, failed: 0 })
    expect(calls).toEqual([])
  })

  it('stamps a fresh timestamp on every attempt, so a late retry is still inside Halo\'s window', async () => {
    answers = [respond(503), respond(200)]
    await inbound(1)
    await dispatcher.runOnce()
    skew += 3 * 3600_000
    await dispatcher.runOnce()
    const [a, b] = calls.map((c) => Number(c.headers['x-vircle-timestamp']))
    expect(b! - a!).toBeGreaterThanOrEqual(3 * 3600 - 1)
    expect(calls[0]!.json.event_id).toBe(calls[1]!.json.event_id)
  })

  it('does not post twice when two passes are asked for at once', async () => {
    await inbound(1)
    const [a, b] = await Promise.all([dispatcher.runOnce(), dispatcher.runOnce()])
    expect(calls).toHaveLength(1)
    expect(a).toBe(b)
  })
})

describe('order', () => {
  it('sends a workspace\'s events in the order they were written', async () => {
    await inbound(1)
    const out = await store.appendOutbound(subject, { idempotencyKey: 'h1', type: 'text', text: 'hi', senderName: null })
    await store.applyReceipt(subject, out.message.seq, 'delivered')
    await inbound(2)
    await dispatcher.runOnce()
    expect(calls.map((c) => c.json.event)).toEqual(['message.inbound', 'message.receipt', 'message.inbound'])
  })

  it('holds back everything behind an event that is waiting to be retried', async () => {
    answers = [respond(503), respond(200)]
    await inbound(1)
    await inbound(2)
    await inbound(3)
    expect(await dispatcher.runOnce()).toEqual({ sent: 0, retrying: 1, failed: 0 })
    expect(calls).toHaveLength(1) // 2 and 3 were not tried ahead of 1
    expect(await pendingTexts()).toEqual(['message 1', 'message 2', 'message 3'])

    skew += 60_000
    expect(await dispatcher.runOnce()).toEqual({ sent: 3, retrying: 0, failed: 0 })
    expect(calls.map((c) => (c.json.message as { text: string }).text)).toEqual(['message 1', 'message 1', 'message 2', 'message 3'])
  })

  it('keeps one workspace\'s trouble from holding up another\'s events', async () => {
    const other = (
      await store.createWorkspace({ ...WORKSPACE, key: 'vcw_otherotherotherother1', apiToken: 'vct_other', haloWebhookUrl: 'https://other.example.com/hook' })
    ).workspace
    const otherSubject = await store.upsertUser(other, { walletId: 'W-o' })
    await inbound(1)
    await store.appendInbound(otherSubject, { clientId: 'o1', type: 'text', text: 'for the other one' })
    answers = [respond(200)]
    const sentTo: string[] = []
    const d = new Dispatcher(store, cfg, {
      fetch: (async (url: string) => {
        sentTo.push(url)
        return url.includes('other') ? respond(200) : respond(503)
      }) as unknown as typeof fetch,
      now,
      random: () => 0.5,
      log: () => undefined,
    })
    expect(await d.runOnce()).toEqual({ sent: 1, retrying: 1, failed: 0 })
    expect(sentTo).toHaveLength(2)
    expect(await store.pendingEvents(other.id)).toEqual([])
    expect(await store.pendingEvents(workspace.id)).toHaveLength(1)
  })
})

describe('retrying', () => {
  it('retries a 5xx, a 429, a wrong-signature 401 and a missing 404, and an unreachable Halo, never giving up early', async () => {
    for (const answer of [respond(500), respond(429), respond(401, { error: 'Invalid signature' }), respond(404), new TypeError('fetch failed')]) {
      calls = []
      answers = [answer]
      const d = makeDispatcher()
      await inbound(Math.floor(Math.random() * 1e6))
      const r = await d.runOnce()
      expect(r.retrying).toBe(1)
      expect(r.failed).toBe(0)
      // clear the queue for the next case
      await db.query('DELETE FROM outbox_events')
    }
  })

  it('waits before trying again: nothing is posted until the wait is over', async () => {
    answers = [respond(503), respond(200)]
    await inbound(1)
    await dispatcher.runOnce()
    expect(calls).toHaveLength(1)
    skew += 500
    await dispatcher.runOnce()
    expect(calls).toHaveLength(1)
    skew += 5000
    await dispatcher.runOnce()
    expect(calls).toHaveLength(2)
    expect(await store.pendingEvents(workspace.id)).toEqual([])
  })

  it('records what went wrong on the event, and counts the attempts', async () => {
    answers = [respond(503, { error: 'Temporary failure' })]
    await inbound(1)
    await dispatcher.runOnce()
    const { rows } = await db.query<{ attempts: number; last_error: string }>('SELECT attempts, last_error FROM outbox_events')
    expect(rows[0]!.attempts).toBe(1)
    expect(rows[0]!.last_error).toMatch(/503/)
  })

  it('lengthens the wait with each attempt, up to a ceiling, and honours Retry-After', () => {
    const d = makeDispatcher({ maxBackoffMs: 60_000 })
    expect([0, 1, 2, 3].map((n) => d.backoffMs(n, null))).toEqual([2000, 4000, 8000, 16_000])
    expect(d.backoffMs(10, null)).toBe(60_000)
    expect(d.backoffMs(0, 30_000)).toBe(30_000)
    expect(d.backoffMs(0, 600_000)).toBe(60_000) // never beyond the ceiling
  })

  it('spreads retries with jitter of at most a fifth either way', () => {
    const low = new Dispatcher(store, cfg, { random: () => 0 })
    const high = new Dispatcher(store, cfg, { random: () => 1 })
    expect(low.backoffMs(3, null)).toBeCloseTo(16_000 * 0.8, 3)
    expect(high.backoffMs(3, null)).toBeCloseTo(16_000 * 1.2, 3)
  })

  it('uses Halo\'s Retry-After for the wait', async () => {
    answers = [respond(429, { error: 'Rate limited' }, { 'retry-after': '120' })]
    await inbound(1)
    await dispatcher.runOnce()
    const { rows } = await db.query<{ next_attempt_at: string }>('SELECT next_attempt_at FROM outbox_events')
    const wait = new Date(rows[0]!.next_attempt_at).getTime() - now()
    expect(wait).toBeGreaterThanOrEqual(119_000)
    expect(wait).toBeLessThanOrEqual(121_000)
  })

  it('gives up after the window, keeps the event with its error, and moves on', async () => {
    answers = [respond(503)]
    await inbound(1)
    await inbound(2)
    await dispatcher.runOnce() // first attempt: retry
    skew += 73 * 3600_000 // past the 72-hour window
    const r = await dispatcher.runOnce()
    expect(r.failed).toBe(2) // the first is given up on, and so is the second, in turn
    const stats = await store.outboxStats()
    expect(stats).toMatchObject({ pending: 0, failed: 2 })
    const failed = await store.failedEvents(null, 10)
    expect(failed[0]!.last_error).toMatch(/Given up after 72 hours/)
  })
})

describe('events Halo refuses for good', () => {
  it('sets aside a 400 (and 413, 422) and carries on with the next event', async () => {
    answers = [respond(400, { error: 'invalid_payload' }), respond(200)]
    await inbound(1)
    await inbound(2)
    const r = await dispatcher.runOnce()
    expect(r).toEqual({ sent: 1, retrying: 0, failed: 1 })
    expect(calls).toHaveLength(2)
    expect(await store.outboxStats()).toMatchObject({ pending: 0, failed: 1 })
    expect((await store.failedEvents(null, 5))[0]!.last_error).toMatch(/400.*invalid_payload/)
  })

  it('puts given-up events back in the queue on request, and sends them', async () => {
    answers = [respond(422)]
    await inbound(1)
    await dispatcher.runOnce()
    expect((await store.outboxStats()).failed).toBe(1)
    expect(await store.requeueFailed(workspace.workspace_key)).toBe(1)
    answers = [respond(200)]
    expect((await dispatcher.runOnce()).sent).toBe(1)
    expect(await store.outboxStats()).toMatchObject({ pending: 0, failed: 0 })
    expect(await store.requeueFailed(null)).toBe(0)
  })
})

describe('failures that are ours', () => {
  it('treats an undecryptable secret as something to retry once it is fixed, not as Halo\'s refusal', async () => {
    await inbound(1)
    await db.query(`UPDATE workspaces SET halo_signing_secret_enc = 'v1:bad:bad:bad'`)
    const r = await dispatcher.runOnce()
    expect(r).toEqual({ sent: 0, retrying: 1, failed: 0 })
    expect(calls).toEqual([])
    expect((await db.query<{ last_error: string }>('SELECT last_error FROM outbox_events')).rows[0]!.last_error).toMatch(/cannot be decrypted/)
  })

  it('stops cleanly: no pass starts after stop', async () => {
    await dispatcher.stop()
    const spy = vi.spyOn(store, 'workspacesWithPendingEvents')
    dispatcher.kick()
    await new Promise((r) => setTimeout(r, 30))
    expect(spy).not.toHaveBeenCalled()
  })
})
