import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Message, Subject } from '../src/store'
import { CLOSE } from '../src/ws-server'
import { connectUser, startHarness, TestClient, type Harness } from './helpers'

let h: Harness
const clients: TestClient[] = []

const track = (c: TestClient) => {
  clients.push(c)
  return c
}
const user = async (u: Parameters<typeof connectUser>[1] = {}, hello: Record<string, unknown> = {}) => {
  const out = await connectUser(h, u, hello)
  track(out.client)
  return out
}

beforeEach(async () => {
  h = await startHarness()
})
afterEach(async () => {
  clients.splice(0).forEach((c) => c.close())
  await h.close()
})

describe('connecting', () => {
  it('welcomes a user with a good token: limits, heartbeat, who they are and where their conversation stands', async () => {
    const { welcome } = await user({ wallet_id: 'W-welcome', name: 'Aisha' })
    expect(welcome).toMatchObject({
      type: 'welcome',
      v: 1,
      heartbeat_s: 25,
      limits: { text_max: 4000, caption_max: 1024, file_max_bytes: 16 * 1024 * 1024 },
      user: { wallet_id: 'W-welcome', name: 'Aisha' },
      conversation: { last_seq: 0 },
    })
    expect(new Date(welcome.server_time as string).getTime()).toBeLessThan(Date.now() + 5000)
    expect(h.gw.hub.isOnline((await h.subject('W-welcome')).user.id)).toBe(true)
  })

  it('refuses a token that is wrong, then closes with 4401', async () => {
    const c = track(await TestClient.connect(h.gw.port))
    c.hello('vcs_not_a_real_token')
    expect(await c.next('error')).toMatchObject({ code: 'unauthorized' })
    expect((await c.untilClosed()).code).toBe(CLOSE.unauthorized)
  })

  it('lets a token be used once', async () => {
    const { token } = await h.session()
    const a = track(await TestClient.connect(h.gw.port))
    a.hello(token)
    await a.next('welcome')
    const b = track(await TestClient.connect(h.gw.port))
    b.hello(token)
    expect(await b.next('error')).toMatchObject({ code: 'unauthorized' })
    expect((await b.untilClosed()).code).toBe(CLOSE.unauthorized)
  })

  it('refuses a token that expired', async () => {
    const { token } = await h.session({ wallet_id: 'W-late' })
    await h.db.query(`UPDATE sessions SET expires_at = now() - interval '1 second'`)
    const c = track(await TestClient.connect(h.gw.port))
    c.hello(token)
    expect(await c.next('error')).toMatchObject({ code: 'unauthorized' })
  })

  it('closes a connection whose first frame is not hello', async () => {
    const c = track(await TestClient.connect(h.gw.port))
    c.send({ type: 'send', client_id: 'x', kind: 'text', text: 'hi' })
    expect(await c.next('error')).toMatchObject({ code: 'hello_required' })
    expect((await c.untilClosed()).code).toBe(CLOSE.unauthorized)
  })

  it('closes a connection that never says hello', async () => {
    await h.close()
    h = await startHarness({ cfg: { helloTimeoutMs: 150 } })
    const c = track(await TestClient.connect(h.gw.port))
    expect(await c.next('error')).toMatchObject({ code: 'hello_timeout' })
    expect((await c.untilClosed()).code).toBe(CLOSE.helloTimeout)
  })

  it('closes on a protocol version it does not speak', async () => {
    const { token } = await h.session()
    const c = track(await TestClient.connect(h.gw.port))
    c.hello(token, { v: 9 })
    expect(await c.next('error')).toMatchObject({ code: 'unsupported_version' })
    expect((await c.untilClosed()).code).toBe(CLOSE.unauthorized)
  })

  it('rejects a path that is not the app endpoint', async () => {
    await expect(TestClient.connect(h.gw.port, '/elsewhere')).rejects.toThrow()
  })

  it('does not accept a second hello on a live connection', async () => {
    const { client } = await user()
    client.send({ type: 'hello', v: 1, token: 'x', device_id: 'd' })
    expect(await client.next('error')).toMatchObject({ code: 'already_connected' })
  })
})

describe('sending', () => {
  it('stores a message in order and acknowledges it with its sequence number', async () => {
    const { client } = await user({ wallet_id: 'W-send' })
    client.send({ type: 'send', client_id: 'c1', kind: 'text', text: 'hello' })
    client.send({ type: 'send', client_id: 'c2', kind: 'text', text: 'world' })
    const a1 = await client.next('ack', (f) => f.client_id === 'c1')
    const a2 = await client.next('ack', (f) => f.client_id === 'c2')
    expect([a1.seq, a2.seq]).toEqual([1, 2])
    expect(a1.server_id).toMatch(/^m_/)
    expect(a1.duplicate).toBeUndefined()

    const s = await h.subject('W-send')
    const stored = await h.gw.store.listAfter(s.conversation.id, 0, 10)
    expect(stored.map((m) => [m.seq, m.direction, m.text])).toEqual([[1, 'in', 'hello'], [2, 'in', 'world']])
  })

  it('answers a repeated client id with the original, marked duplicate, and stores nothing new', async () => {
    const { client } = await user({ wallet_id: 'W-dup' })
    client.send({ type: 'send', client_id: 'same', kind: 'text', text: 'once' })
    const first = await client.next('ack')
    client.send({ type: 'send', client_id: 'same', kind: 'text', text: 'once' })
    const second = await client.next('ack')
    expect(second).toMatchObject({ server_id: first.server_id, seq: first.seq, duplicate: true })
    const s = await h.subject('W-dup')
    expect(await h.gw.store.listAfter(s.conversation.id, 0, 10)).toHaveLength(1)
  })

  it('tells the hook about each new message once, and not about a duplicate', async () => {
    const stored = vi.fn<(subject: Subject, message: Message) => void>()
    await h.close()
    h = await startHarness({ hooks: { inboundStored: stored } })
    const { client } = await user({ wallet_id: 'W-hook' })
    client.send({ type: 'send', client_id: 'h1', kind: 'text', text: 'a' })
    await client.next('ack')
    client.send({ type: 'send', client_id: 'h1', kind: 'text', text: 'a' })
    await client.next('ack')
    expect(stored).toHaveBeenCalledTimes(1)
    expect(stored.mock.calls[0]![1]).toMatchObject({ text: 'a', direction: 'in' })
    expect(stored.mock.calls[0]![0].user.wallet_id).toBe('W-hook')
  })

  it('refuses an over-long message and a malformed send without closing the connection', async () => {
    const { client } = await user()
    client.send({ type: 'send', client_id: 'long', kind: 'text', text: 'x'.repeat(4001) })
    expect(await client.next('error')).toMatchObject({ code: 'message_too_long' })
    client.send({ type: 'send', kind: 'text', text: 'no id' })
    expect(await client.next('error')).toMatchObject({ code: 'bad_frame' })
    client.send({ type: 'send', client_id: 'ok', kind: 'text', text: 'still works' })
    expect(await client.next('ack')).toMatchObject({ client_id: 'ok' })
  })

  it('says files are not available yet', async () => {
    const { client } = await user()
    client.send({ type: 'send', client_id: 'f', kind: 'image', media: { file_id: 'x' } })
    expect(await client.next('error')).toMatchObject({ code: 'unsupported_kind' })
  })

  it('limits how fast one user may send, and says when to retry', async () => {
    await h.close()
    h = await startHarness({ cfg: { sendRateLimit: { limit: 3, windowMs: 60_000 } } })
    const { client } = await user({ wallet_id: 'W-rate' })
    for (let i = 0; i < 3; i++) {
      client.send({ type: 'send', client_id: `r${i}`, kind: 'text', text: 'x' })
      await client.next('ack')
    }
    client.send({ type: 'send', client_id: 'r3', kind: 'text', text: 'x' })
    const err = await client.next('error')
    expect(err).toMatchObject({ code: 'rate_limited' })
    expect(err.retry_after).toBeGreaterThan(0)
    // the refused one was not stored
    const s = await h.subject('W-rate')
    expect(await h.gw.store.listAfter(s.conversation.id, 0, 10)).toHaveLength(3)
  })

  it('closes a connection that keeps sending garbage', async () => {
    const { client } = await user()
    for (let i = 0; i < 5; i++) client.sendRaw('not json')
    expect((await client.untilClosed()).code).toBe(CLOSE.tooManyErrors)
  })

  it('does not accept binary frames', async () => {
    const { client } = await user()
    client.sendRaw(Buffer.from([1, 2, 3]))
    expect(await client.next('error')).toMatchObject({ code: 'bad_frame' })
  })
})

describe('several devices', () => {
  it('shows a message sent on one device on the others, with direction "in"', async () => {
    const phone = await user({ wallet_id: 'W-multi' }, { device_id: 'phone' })
    const tablet = await user({ wallet_id: 'W-multi' }, { device_id: 'tablet' })
    phone.client.send({ type: 'send', client_id: 'm1', kind: 'text', text: 'from the phone' })
    await phone.client.next('ack')
    const seen = await tablet.client.next('deliver')
    expect(seen).toMatchObject({ direction: 'in', kind: 'text', text: 'from the phone', seq: 1 })
    // and the sender does not get its own message echoed back
    await new Promise((r) => setTimeout(r, 50))
    expect(phone.client.frames.filter((f) => f.type === 'deliver')).toEqual([])
  })

  it('replaces a device that connects again, closing the old connection with 4409', async () => {
    const first = await user({ wallet_id: 'W-replace' }, { device_id: 'phone' })
    const second = await user({ wallet_id: 'W-replace' }, { device_id: 'phone' })
    expect((await first.client.untilClosed()).code).toBe(CLOSE.replaced)
    const s = await h.subject('W-replace')
    expect(h.gw.hub.connectionsOf(s.user.id)).toHaveLength(1)
    second.client.send({ type: 'ping', t: 1 })
    expect(await second.client.next('pong')).toMatchObject({ t: 1 })
  })

  it('keeps users apart: one user\'s messages never reach another', async () => {
    const a = await user({ wallet_id: 'W-a' }, { device_id: 'd' })
    const b = await user({ wallet_id: 'W-b' }, { device_id: 'd' })
    a.client.send({ type: 'send', client_id: 'a1', kind: 'text', text: 'private to a' })
    await a.client.next('ack')
    await new Promise((r) => setTimeout(r, 50))
    expect(b.client.frames.filter((f) => f.type === 'deliver')).toEqual([])
  })

  it('drops a user from the online list when the last device leaves', async () => {
    const { client } = await user({ wallet_id: 'W-off' })
    const s = await h.subject('W-off')
    expect(h.gw.hub.isOnline(s.user.id)).toBe(true)
    client.close()
    await vi.waitFor(() => expect(h.gw.hub.isOnline(s.user.id)).toBe(false))
  })
})

describe('resuming', () => {
  async function seedFromHalo(walletId: string, n: number) {
    const s = await h.subject(walletId)
    for (let i = 1; i <= n; i++) {
      await h.gw.store.appendOutbound(s, { idempotencyKey: `${walletId}-${i}`, type: 'text', text: `reply ${i}`, senderName: 'Sam' })
    }
    return s
  }

  it('replays what the app missed, oldest first, then says where it stopped', async () => {
    const { client } = await user({ wallet_id: 'W-resume' })
    await seedFromHalo('W-resume', 4)
    client.send({ type: 'resume', last_seq: 1 })
    const seqs: unknown[] = []
    for (let i = 0; i < 3; i++) seqs.push((await client.next('deliver')).seq)
    expect(seqs).toEqual([2, 3, 4])
    expect(await client.next('resume_done')).toMatchObject({ up_to_seq: 4, more: false })
  })

  it('replays on hello when the app says where it was', async () => {
    const { token } = await h.session({ wallet_id: 'W-hello-resume' })
    await seedFromHalo('W-hello-resume', 3)
    const c = track(await TestClient.connect(h.gw.port))
    c.hello(token, { last_seq: 1 })
    await c.next('welcome')
    expect((await c.next('deliver')).seq).toBe(2)
    expect((await c.next('deliver')).seq).toBe(3)
    expect(await c.next('resume_done')).toMatchObject({ up_to_seq: 3 })
  })

  it('carries the sender, kind, status and time on each replayed message', async () => {
    const { client } = await user({ wallet_id: 'W-shape' })
    await seedFromHalo('W-shape', 1)
    client.send({ type: 'resume', last_seq: 0 })
    expect(await client.next('deliver')).toMatchObject({
      server_id: expect.stringMatching(/^m_/),
      seq: 1,
      direction: 'out',
      kind: 'text',
      text: 'reply 1',
      media: null,
      sender: { name: 'Sam' },
      status: 'sent',
      conversation_id: expect.stringMatching(/^c_/),
      sent_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    })
  })

  it('pages a long gap: a full batch says more is coming, and the app asks again from where it stopped', async () => {
    await h.close()
    h = await startHarness({ cfg: { replayBatch: 2 } })
    const { client } = await user({ wallet_id: 'W-page' })
    await seedFromHalo('W-page', 5)
    client.send({ type: 'resume', last_seq: 0 })
    expect((await client.next('deliver')).seq).toBe(1)
    expect((await client.next('deliver')).seq).toBe(2)
    expect(await client.next('resume_done')).toMatchObject({ up_to_seq: 2, more: true })
    client.send({ type: 'resume', last_seq: 2 })
    expect((await client.next('deliver')).seq).toBe(3)
    expect((await client.next('deliver')).seq).toBe(4)
    expect(await client.next('resume_done')).toMatchObject({ up_to_seq: 4, more: true })
    client.send({ type: 'resume', last_seq: 4 })
    expect((await client.next('deliver')).seq).toBe(5)
    expect(await client.next('resume_done')).toMatchObject({ up_to_seq: 5, more: false })
  })

  it('says there is nothing when the app is up to date', async () => {
    const { client } = await user({ wallet_id: 'W-current' })
    await seedFromHalo('W-current', 2)
    client.send({ type: 'resume', last_seq: 2 })
    expect(await client.next('resume_done')).toMatchObject({ up_to_seq: 2, more: false })
    expect(client.frames.filter((f) => f.type === 'deliver')).toEqual([])
  })

  it('never replays another user\'s conversation', async () => {
    await user({ wallet_id: 'W-victim' })
    await seedFromHalo('W-victim', 2)
    const { client } = await user({ wallet_id: 'W-snoop' })
    client.send({ type: 'resume', last_seq: 0 })
    expect(await client.next('resume_done')).toMatchObject({ up_to_seq: 0 })
    expect(client.frames.filter((f) => f.type === 'deliver')).toEqual([])
  })

  it('a message sent before the connection dropped is not stored twice when the app retries it after reconnecting', async () => {
    const first = await user({ wallet_id: 'W-retry' })
    first.client.send({ type: 'send', client_id: 'lost-ack', kind: 'text', text: 'did it arrive?' })
    const ack = await first.client.next('ack')
    first.client.close() // the ack may never have reached the app, as far as it knows
    const second = await user({ wallet_id: 'W-retry' })
    second.client.send({ type: 'send', client_id: 'lost-ack', kind: 'text', text: 'did it arrive?' })
    expect(await second.client.next('ack')).toMatchObject({ server_id: ack.server_id, duplicate: true })
  })
})

describe('receipts', () => {
  it('records delivered and read for Halo\'s messages and queues an event for Halo for each', async () => {
    const { client } = await user({ wallet_id: 'W-receipt' })
    const s = await h.subject('W-receipt')
    const m1 = await h.gw.store.appendOutbound(s, { idempotencyKey: 'rc1', type: 'text', text: 'a', senderName: null })
    const m2 = await h.gw.store.appendOutbound(s, { idempotencyKey: 'rc2', type: 'text', text: 'b', senderName: null })

    client.send({ type: 'receipt', up_to_seq: m2.message.seq, status: 'delivered' })
    await vi.waitFor(async () => expect((await h.gw.store.getMessage(m2.message.id))?.status).toBe('delivered'))
    client.send({ type: 'receipt', up_to_seq: m1.message.seq, status: 'read' })
    await vi.waitFor(async () => expect((await h.gw.store.getMessage(m1.message.id))?.status).toBe('read'))
    expect((await h.gw.store.getMessage(m2.message.id))?.status).toBe('delivered')

    const events = (await h.gw.store.pendingEvents(h.workspace.id)).filter((e) => e.kind === 'message.receipt')
    expect(events.map((e) => [(e.payload as { server_id: string }).server_id, (e.payload as { status: string }).status]).sort()).toEqual(
      [[m1.message.id, 'delivered'], [m1.message.id, 'read'], [m2.message.id, 'delivered']].sort(),
    )
  })

  it('tells the hook which messages changed', async () => {
    const receipts = vi.fn<(subject: Subject, messages: Message[]) => void>()
    await h.close()
    h = await startHarness({ hooks: { receiptsApplied: receipts } })
    const { client } = await user({ wallet_id: 'W-rhook' })
    const s = await h.subject('W-rhook')
    const m = await h.gw.store.appendOutbound(s, { idempotencyKey: 'rh1', type: 'text', text: 'a', senderName: null })
    client.send({ type: 'receipt', up_to_seq: m.message.seq, status: 'read' })
    await vi.waitFor(() => expect(receipts).toHaveBeenCalledTimes(1))
    expect(receipts.mock.calls[0]![1].map((x) => x.id)).toEqual([m.message.id])
    // a repeat changes nothing, so the hook is not told again
    client.send({ type: 'receipt', up_to_seq: m.message.seq, status: 'read' })
    client.send({ type: 'ping' })
    await client.next('pong')
    expect(receipts).toHaveBeenCalledTimes(1)
  })
})

describe('keeping the connection alive', () => {
  it('answers ping with pong, echoing what was sent', async () => {
    const { client } = await user()
    client.send({ type: 'ping', t: 'abc' })
    expect(await client.next('pong')).toMatchObject({ t: 'abc' })
    client.send({ type: 'ping' })
    expect(await client.next('pong')).toMatchObject({ t: null })
  })

  it('accepts typing without complaint', async () => {
    const { client } = await user()
    client.send({ type: 'typing' })
    client.send({ type: 'ping', t: 2 })
    expect(await client.next('pong')).toMatchObject({ t: 2 })
    expect(client.frames.filter((f) => f.type === 'error')).toEqual([])
  })

  it('drops a connection that stops answering the server\'s pings', async () => {
    await h.close()
    h = await startHarness({ cfg: { heartbeatSeconds: 1 } })
    const { client } = await user({ wallet_id: 'W-silent' })
    // A client that has stopped reading cannot pong. Simulate it by pausing the socket.
    ;(client.ws as unknown as { _socket: { pause(): void } })._socket.pause()
    const s = await h.subject('W-silent')
    await vi.waitFor(() => expect(h.gw.hub.isOnline(s.user.id)).toBe(false), { timeout: 6000, interval: 100 })
  })
})

describe('shutting down', () => {
  it('closes every connection with the restart code so apps resume against the next instance', async () => {
    const a = await user({ wallet_id: 'W-r1' })
    const b = await user({ wallet_id: 'W-r2' })
    await h.gw.close()
    expect((await a.client.untilClosed()).code).toBe(CLOSE.serviceRestart)
    expect((await b.client.untilClosed()).code).toBe(CLOSE.serviceRestart)
    // afterEach closes the gateway again; that must be harmless
    h.gw.close = async () => undefined
  })
})
