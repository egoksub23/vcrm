import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { connectUser, startHarness, WORKSPACE, type Harness, type TestClient } from './helpers'

let h: Harness
/** Milliseconds added to the real clock for the delivery service, so a test can move time forward. */
let skew = 0
const clients: TestClient[] = []

async function start(opts: Parameters<typeof startHarness>[0] = {}) {
  skew = 0
  h = await startHarness({ ...opts, delivery: { now: () => Date.now() + skew, log: () => undefined, ...opts?.delivery } })
}
beforeEach(async () => start())
afterEach(async () => {
  clients.splice(0).forEach((c) => c.close())
  await h.close()
})

const ME = { wallet_id: 'W-push', name: 'Aisha', phone: '+60123456789', email: 'aisha@example.com' }

const sendFromHalo = async (over: Record<string, unknown> = {}, key = `k-${Math.random()}`) => {
  const res = await fetch(`${h.url}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${WORKSPACE.apiToken}`, 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ recipient: ME, type: 'text', text: 'Your top-up is fixed', sender: { name: 'Support' }, ...over }),
  })
  expect(res.status).toBe(202)
  return (await res.json()) as { server_id: string; seq: number; conversation_id: string; delivery: string }
}
const connect = async (user = ME, hello: Record<string, unknown> = {}) => {
  const out = await connectUser(h, user, hello)
  clients.push(out.client)
  return out.client
}
const conversationOf = async (walletId = ME.wallet_id) => (await h.subject(walletId)).conversation.id
const statusOf = async (messageId: string) => (await h.gw.store.getMessage(messageId))?.status

describe('a user who is offline', () => {
  it('is alerted at once, with a generic text, a deep link to the conversation and a collapse key', async () => {
    const sent = await sendFromHalo()
    expect(sent.delivery).toBe('push')
    expect(h.push.sent).toHaveLength(1)
    expect(h.push.sent[0]).toMatchObject({
      phone: ME.phone,
      email: 'aisha@example.com',
      walletId: ME.wallet_id,
      title: 'Vircle',
      body: 'You have a new message',
      deepLink: `vircle://chat/${sent.conversation_id}`,
      collapseKey: sent.conversation_id,
      result: { status: 'sent' },
    })
  })

  it('never puts the message itself in the alert', async () => {
    await sendFromHalo({ text: 'Your PIN reset code is 482913' })
    const { result: _r, at: _a, ...request } = h.push.sent[0]!
    expect(JSON.stringify(request)).not.toMatch(/482913|PIN|top-up/)
  })

  it('is alerted once per away period: later messages while the first alert stands raise none', async () => {
    const first = await sendFromHalo()
    const second = await sendFromHalo({ text: 'second' })
    const third = await sendFromHalo({ text: 'third' })
    expect([first.delivery, second.delivery, third.delivery]).toEqual(['push', 'queued', 'queued'])
    expect(h.push.sent).toHaveLength(1)
  })

  it('is alerted once even when several messages arrive at the same moment', async () => {
    const answers = await Promise.all(Array.from({ length: 6 }, (_, i) => sendFromHalo({ text: `burst ${i}` })))
    expect(answers.filter((a) => a.delivery === 'push')).toHaveLength(1)
    expect(h.push.sent).toHaveLength(1)
  })

  it('is alerted again after coming back and leaving again', async () => {
    await sendFromHalo()
    const client = await connect()
    client.close()
    await vi.waitFor(() => expect(h.gw.hub.size).toBe(0))
    await sendFromHalo({ text: 'next time' })
    expect(h.push.sent).toHaveLength(2)
  })

  it('is reminded once after PUSH_REALERT_HOURS if they still have not come back, and not before', async () => {
    await sendFromHalo()
    skew += 23 * 3_600_000
    expect((await sendFromHalo({ text: 'later' })).delivery).toBe('queued')
    skew += 2 * 3_600_000 // 25 hours since the first alert
    expect((await sendFromHalo({ text: 'much later' })).delivery).toBe('push')
    expect(h.push.sent).toHaveLength(2)
    expect((await sendFromHalo({ text: 'right after' })).delivery).toBe('queued')
  })

  it('does not alert again for a message Halo repeats (same Idempotency-Key)', async () => {
    const a = await sendFromHalo({}, 'same')
    await h.gw.store.clearAlert(a.conversation_id) // even if the user had been back in between
    const b = await sendFromHalo({}, 'same')
    expect(b).toEqual(a)
    expect(h.push.sent).toHaveLength(1)
  })

  it('has the message waiting, replayed in order when they connect', async () => {
    await sendFromHalo({ text: 'one' })
    await sendFromHalo({ text: 'two' })
    const client = await connect(ME, { last_seq: 0 })
    expect((await client.next('deliver')).text).toBe('one')
    expect((await client.next('deliver')).text).toBe('two')
  })
})

describe('what the alert needs', () => {
  it('is skipped, and the message queued, for a user the gateway has neither a phone nor an email for', async () => {
    const sent = await sendFromHalo({ recipient: { wallet_id: 'W-nobody-to-call' } })
    expect(sent.delivery).toBe('queued')
    expect(h.push.sent).toEqual([])
    expect((await h.gw.store.pushLog(sent.conversation_id))[0]).toMatchObject({ outcome: 'skipped', detail: expect.stringMatching(/neither a phone number nor an email/) })
  })

  it('uses the email alone, or the phone alone, when that is all there is', async () => {
    await sendFromHalo({ recipient: { wallet_id: 'W-email-only', email: 'e@example.com' } })
    await sendFromHalo({ recipient: { wallet_id: 'W-phone-only', phone: '+60100000000' } })
    expect(h.push.sent.map((p) => [p.phone, p.email])).toEqual([[null, 'e@example.com'], ['+60100000000', null]])
  })

  it('takes the title, text and deep link a workspace configured, filling in the placeholders', async () => {
    await h.db.query(`UPDATE workspaces SET push_settings = $1::jsonb`, [
      JSON.stringify({ title: 'Vircle Care', body: 'Care has replied', deep_link: 'vircle://care?c={conversation_id}&w={wallet_id}' }),
    ])
    const sent = await sendFromHalo()
    expect(h.push.sent[0]).toMatchObject({ title: 'Vircle Care', body: 'Care has replied', deepLink: `vircle://care?c=${sent.conversation_id}&w=W-push` })
  })
})

describe('what the push API says', () => {
  it('"no device": the answer is no_device and the API is not asked again for every message', async () => {
    h.push.noDeviceFor(ME.phone)
    expect((await sendFromHalo()).delivery).toBe('no_device')
    expect((await sendFromHalo({ text: 'again' })).delivery).toBe('queued')
    expect(h.push.sent).toHaveLength(1)
  })

  it('a failure that a retry may fix: the message is queued, and the sweeper tries again after a wait, not before', async () => {
    h.push.answerNext({ status: 'failed', error: 'push API answered 503', retryable: true })
    const sent = await sendFromHalo()
    expect(sent.delivery).toBe('queued')
    expect(h.push.sent).toHaveLength(1)

    skew += 5_000 // too soon (first wait is 30 seconds)
    await h.gw.delivery.sweep()
    expect(h.push.sent).toHaveLength(1)

    skew += 30_000
    await h.gw.delivery.sweep()
    expect(h.push.sent).toHaveLength(2)
    expect(h.push.sent[1]!.result).toEqual({ status: 'sent' })

    // done: later sweeps do not alert again for the same messages
    skew += 60_000
    await h.gw.delivery.sweep()
    expect(h.push.sent).toHaveLength(2)
    expect((await h.gw.store.pushLog(sent.conversation_id)).map((l) => l.outcome)).toEqual(['sent', 'failed'])
  })

  it('waits longer after each failure and gives up after five tries', async () => {
    h.push.answerWith(() => ({ status: 'failed', error: 'down', retryable: true }))
    await sendFromHalo()
    const waits: number[] = []
    for (let i = 0; i < 6; i++) {
      const before = h.push.sent.length
      skew += 5 * 60_000 // past each wait (30 s, 1, 2, 4 minutes), inside the one-hour window
      await h.gw.delivery.sweep()
      waits.push(h.push.sent.length - before)
    }
    expect(h.push.sent).toHaveLength(5) // the first try plus four retries, then no more
    expect(waits).toEqual([1, 1, 1, 1, 0, 0])
  })

  it('a refusal a retry cannot fix is not retried, and does not stop the next message trying', async () => {
    h.push.answerNext({ status: 'failed', error: 'bad request', retryable: false })
    expect((await sendFromHalo()).delivery).toBe('queued')
    skew += 3_600_000
    await h.gw.delivery.sweep()
    expect(h.push.sent).toHaveLength(1)
    expect((await sendFromHalo({ text: 'second' })).delivery).toBe('push')
  })

  it('an adapter that throws is a failure to retry, never an error for Halo', async () => {
    const original = h.push.send.bind(h.push)
    let first = true
    h.push.send = async (req) => {
      if (first) {
        first = false
        throw new Error('socket hang up')
      }
      return original(req)
    }
    const sent = await sendFromHalo()
    expect(sent.delivery).toBe('queued')
    expect((await h.gw.store.pushLog(sent.conversation_id))[0]).toMatchObject({ outcome: 'failed', detail: 'socket hang up' })
  })
})

describe('a user who is online', () => {
  it('gets the message on the connection and is not alerted', async () => {
    const client = await connect()
    const sent = await sendFromHalo()
    expect(sent.delivery).toBe('socket')
    expect((await client.next('deliver')).server_id).toBe(sent.server_id)
    expect(h.push.sent).toEqual([])
  })

  it('is not alerted when the app acknowledges in time', async () => {
    const client = await connect()
    const sent = await sendFromHalo()
    await client.next('deliver')
    client.send({ type: 'receipt', up_to_seq: sent.seq, status: 'delivered' })
    await vi.waitFor(async () => expect(await statusOf(sent.server_id)).toBe('delivered'))
    skew += 60_000
    await h.gw.delivery.sweep()
    expect(h.push.sent).toEqual([])
  })

  it('is not alerted before the acknowledgement time is up, and is alerted once it is, if the app stayed silent', async () => {
    await connect()
    const sent = await sendFromHalo()
    skew += 2_000
    await h.gw.delivery.sweep()
    expect(h.push.sent).toEqual([])
    skew += 4_000 // past the 5 seconds
    expect(await h.gw.delivery.sweep()).toBe(1)
    expect(h.push.sent).toHaveLength(1)
    expect(h.push.sent[0]).toMatchObject({ collapseKey: sent.conversation_id })
    // the answer Halo got stays "socket": that is what the gateway did at the time
    expect((await h.gw.store.getMessage(sent.server_id))?.delivery).toBe('socket')
    // and the sweeper does not alert again for it
    skew += 60_000
    await h.gw.delivery.sweep()
    expect(h.push.sent).toHaveLength(1)
  })

  it('is alerted once for several unacknowledged messages', async () => {
    await connect()
    await sendFromHalo({ text: 'a' })
    await sendFromHalo({ text: 'b' })
    await sendFromHalo({ text: 'c' })
    skew += 6_000
    await h.gw.delivery.sweep()
    expect(h.push.sent).toHaveLength(1)
  })

  it('is alerted when the connection drops before they acknowledge', async () => {
    const client = await connect()
    await sendFromHalo()
    client.close()
    await vi.waitFor(() => expect(h.gw.hub.size).toBe(0))
    skew += 6_000
    await h.gw.delivery.sweep()
    expect(h.push.sent).toHaveLength(1)
  })

  it('stops being an away period when they acknowledge anything, and a later message is alerted again', async () => {
    await sendFromHalo() // offline: alert 1
    const client = await connect(ME, { last_seq: 0 })
    await client.next('deliver')
    client.send({ type: 'receipt', up_to_seq: 1, status: 'delivered' })
    await vi.waitFor(async () => expect((await h.gw.store.alertState(await conversationOf()))?.alert_open).toBe(false))
    client.close()
    await vi.waitFor(() => expect(h.gw.hub.size).toBe(0))
    expect((await sendFromHalo({ text: 'again' })).delivery).toBe('push')
    expect(h.push.sent).toHaveLength(2)
  })

  it('stops being an away period when the user sends a message', async () => {
    await sendFromHalo()
    const state = async () => (await h.gw.store.alertState(await conversationOf()))?.alert_open
    expect(await state()).toBe(true)
    const client = await connect()
    // hello itself ended it; set it again to see that a send ends it too
    await h.db.query(`UPDATE conversations SET alert_open = true`)
    client.send({ type: 'send', client_id: 'x', kind: 'text', text: 'hello?' })
    await client.next('ack')
    expect(await state()).toBe(false)
  })
})

describe('the sweeper', () => {
  it('gives up on a message that stayed unacknowledged past the window: no alert for it', async () => {
    await connect()
    await sendFromHalo()
    skew += 61 * 60_000
    await h.gw.delivery.sweep()
    expect(h.push.sent).toEqual([])
  })

  it('runs on its own timer when enabled', async () => {
    await h.close()
    await start({ cfg: { push: { ...(await import('../src/config')).testConfig().push, ackTimeoutMs: 100, sweepMs: 50 } }, delivery: { sweeper: true } })
    await connect()
    await sendFromHalo()
    await vi.waitFor(() => expect(h.push.sent).toHaveLength(1), { timeout: 5000, interval: 50 })
  })
})

describe('the push log', () => {
  it('records the alerts and the decisions not to alert, newest first', async () => {
    const first = await sendFromHalo()
    await sendFromHalo({ text: 'covered by the first' })
    const log = await h.gw.store.pushLog(first.conversation_id)
    expect(log.map((l) => l.outcome)).toEqual(['skipped', 'sent'])
    expect(log[0]!.detail).toMatch(/already outstanding/)
    expect(log[1]!.message_id).toBe(first.server_id)
  })
})
