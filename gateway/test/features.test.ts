// Contract 1.2: ticks back to the app, replies that quote a message, typing in both directions.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { signBody } from '../src/signing'
import { connectUser, startHarness, TestClient, WORKSPACE, type Harness } from './helpers'

let h: Harness
const clients: TestClient[] = []
/** What the pretend Halo was sent, and what it answers. */
let received: { headers: Headers; raw: string; json: Record<string, any> }[] = []
let haloStatus = 200

async function start(opts: Parameters<typeof startHarness>[0] = {}) {
  received = []
  haloStatus = 200
  h = await startHarness({
    dispatcher: {
      fetch: (async (_url: string, init: RequestInit) => {
        const raw = String(init.body)
        received.push({ headers: new Headers(init.headers), raw, json: JSON.parse(raw) })
        return new Response('{"ok":true}', { status: haloStatus })
      }) as unknown as typeof fetch,
      log: () => undefined,
    },
    ...opts,
  })
}
afterEach(async () => {
  clients.splice(0).forEach((c) => c.close())
  await h.close()
})

const user = async (u: Parameters<typeof connectUser>[1] = {}, hello: Record<string, unknown> = {}) => {
  const out = await connectUser(h, u, hello)
  clients.push(out.client)
  return out.client
}
const post = (path: string, body: unknown, token: string | null = WORKSPACE.apiToken, extra: Record<string, string> = {}) =>
  fetch(`${h.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: JSON.stringify(body),
  })
const fromHalo = async (wallet: string, text: string, extra: Record<string, unknown> = {}) => {
  const res = await post('/v1/messages', { recipient: { wallet_id: wallet, name: 'Aisha', phone: '+60123456789' }, type: 'text', text, sender: { name: 'Support' }, ...extra }, WORKSPACE.apiToken, { 'idempotency-key': `k-${Math.random()}` })
  expect(res.status).toBe(202)
  return (await res.json()) as { server_id: string; seq: number; conversation_id: string; delivery: string }
}
const sendFromApp = async (client: TestClient, text: string, extra: Record<string, unknown> = {}) => {
  const clientId = `c-${Math.random()}`
  client.send({ type: 'send', client_id: clientId, kind: 'text', text, ...extra })
  return client.next('ack', (f) => f.client_id === clientId)
}

describe('"delivered" to support, and "read" by an agent', () => {
  it('a message of the user\'s becomes delivered when Halo accepts the event, and the app is told', async () => {
    await start()
    const client = await user({ wallet_id: 'W-tick' })
    const ack = await sendFromApp(client, 'hello support')
    expect(await client.next('receipt')).toMatchObject({ status: 'delivered', conversation_id: expect.stringMatching(/^c_/), messages: [{ server_id: ack.server_id, seq: ack.seq }] })
    expect((await h.gw.store.getMessage(ack.server_id as string))?.status).toBe('delivered')
  })

  it('stays "sent" while Halo is not accepting events, and moves when it does', async () => {
    await start()
    haloStatus = 503
    const client = await user({ wallet_id: 'W-tick-late' })
    const ack = await sendFromApp(client, 'hello')
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0))
    expect((await h.gw.store.getMessage(ack.server_id as string))?.status).toBe('sent')
    expect(client.frames.filter((f) => f.type === 'receipt')).toEqual([])
    haloStatus = 200
    await h.db.query('UPDATE outbox_events SET next_attempt_at = now()')
    h.gw.dispatcher!.kick()
    expect(await client.next('receipt')).toMatchObject({ status: 'delivered' })
  })

  it('Halo says an agent read them: the app is told, once, and the status never goes back', async () => {
    await start()
    const client = await user({ wallet_id: 'W-read' })
    const a = await sendFromApp(client, 'first')
    const b = await sendFromApp(client, 'second')
    await client.next('receipt')
    await client.next('receipt')

    const res = await post('/v1/receipts', { recipient: { wallet_id: 'W-read' }, status: 'read', server_ids: [a.server_id, b.server_id] })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ updated: 2 })
    expect(await client.next('receipt')).toMatchObject({ status: 'read', messages: [{ server_id: a.server_id }, { server_id: b.server_id }] })

    // a repeat changes nothing and says nothing
    expect(await (await post('/v1/receipts', { recipient: { wallet_id: 'W-read' }, status: 'read', server_ids: [a.server_id] })).json()).toEqual({ updated: 0 })
    // and a late "delivered" never pulls a read message back
    expect(await (await post('/v1/receipts', { recipient: { wallet_id: 'W-read' }, status: 'delivered', server_ids: [a.server_id] })).json()).toEqual({ updated: 0 })
    expect((await h.gw.store.getMessage(a.server_id as string))?.status).toBe('read')
  })

  it('reaches every device, and a device that was closed sees the status when it connects', async () => {
    await start()
    const phone = await user({ wallet_id: 'W-multi-read' }, { device_id: 'phone' })
    const tablet = await user({ wallet_id: 'W-multi-read' }, { device_id: 'tablet' })
    const ack = await sendFromApp(phone, 'seen by both')
    await phone.next('receipt')
    await post('/v1/receipts', { recipient: { wallet_id: 'W-multi-read' }, status: 'read', server_ids: [ack.server_id] })
    expect((await tablet.next('receipt', (f) => f.status === 'read')).messages).toEqual([{ server_id: ack.server_id, seq: ack.seq }])

    phone.close()
    await vi.waitFor(() => expect(h.gw.hub.size).toBe(1))
    const later = await user({ wallet_id: 'W-multi-read' }, { device_id: 'phone-2', last_seq: 0 })
    expect(await later.next('deliver')).toMatchObject({ server_id: ack.server_id, direction: 'in', status: 'read' })
  })

  it('ignores ids that are not the user\'s, are Halo\'s own messages, or are unknown', async () => {
    await start()
    const mine = await user({ wallet_id: 'W-mine-read' })
    const theirs = await user({ wallet_id: 'W-theirs-read' })
    const ackTheirs = await sendFromApp(theirs, 'not yours to read')
    await theirs.next('receipt')
    const halo = await fromHalo('W-mine-read', 'from support')
    await mine.next('deliver')

    const res = await post('/v1/receipts', { recipient: { wallet_id: 'W-mine-read' }, status: 'read', server_ids: [ackTheirs.server_id, halo.server_id, 'm_nonexistent'] })
    expect(await res.json()).toEqual({ updated: 0 })
    expect((await h.gw.store.getMessage(ackTheirs.server_id as string))?.status).toBe('delivered')
    expect((await h.gw.store.getMessage(halo.server_id))?.status).toBe('sent')
  })

  it('answers an unknown user with nothing updated, and checks the request', async () => {
    await start()
    expect(await (await post('/v1/receipts', { recipient: { wallet_id: 'W-nobody' }, status: 'read', server_ids: ['m_1'] })).json()).toEqual({ updated: 0 })
    expect((await post('/v1/receipts', { recipient: { wallet_id: 'W' }, status: 'read', server_ids: ['m_1'] }, null)).status).toBe(401)
    expect((await post('/v1/receipts', { recipient: { wallet_id: 'W' }, status: 'seen', server_ids: ['m_1'] })).status).toBe(400)
    expect((await post('/v1/receipts', { recipient: {}, status: 'read', server_ids: ['m_1'] })).status).toBe(400)
    expect((await post('/v1/receipts', { recipient: { wallet_id: 'W' }, status: 'read', server_ids: [] })).status).toBe(400)
    expect((await post('/v1/receipts', { recipient: { wallet_id: 'W' }, status: 'read', server_ids: Array.from({ length: 201 }, (_, i) => `m_${i}`) })).status).toBe(400)
  })
})

describe('replies', () => {
  it('a reply from the app carries the quoted message to the user\'s other devices and to Halo', async () => {
    await start()
    const phone = await user({ wallet_id: 'W-reply' }, { device_id: 'phone' })
    const tablet = await user({ wallet_id: 'W-reply' }, { device_id: 'tablet' })
    const halo = await fromHalo('W-reply', 'Did you try restarting the app? It usually fixes this and a lot more besides what we can say here')
    await phone.next('deliver')
    await tablet.next('deliver')

    await sendFromApp(phone, 'yes, still broken', { reply_to: halo.server_id })
    const seen = await tablet.next('deliver')
    expect(seen.reply_to).toEqual({ server_id: halo.server_id, kind: 'text', text: expect.stringMatching(/^Did you try restarting/), from: 'support' })
    expect((seen.reply_to as { text: string }).text.length).toBeLessThanOrEqual(140)

    await vi.waitFor(() => expect(received.some((r) => r.json.event === 'message.inbound')).toBe(true))
    const inbound = received.find((r) => r.json.event === 'message.inbound')!
    expect(inbound.json.message.reply_to_server_id).toBe(halo.server_id)
  })

  it('quoting the user\'s own earlier message says it was theirs', async () => {
    await start()
    const phone = await user({ wallet_id: 'W-self-quote' }, { device_id: 'phone' })
    const tablet = await user({ wallet_id: 'W-self-quote' }, { device_id: 'tablet' })
    const first = await sendFromApp(phone, 'my first message')
    await tablet.next('deliver')
    await sendFromApp(phone, 'as I said', { reply_to: first.server_id })
    expect((await tablet.next('deliver')).reply_to).toMatchObject({ from: 'you', text: 'my first message' })
  })

  it('a reply from Halo shows the quote in the app', async () => {
    await start()
    const client = await user({ wallet_id: 'W-halo-reply' })
    const asked = await sendFromApp(client, 'how do I top up?')
    await fromHalo('W-halo-reply', 'Go to Wallet, then Top up.', { reply_to_server_id: asked.server_id })
    expect((await client.next('deliver', (f) => f.direction === 'out')).reply_to).toEqual({ server_id: asked.server_id, kind: 'text', text: 'how do I top up?', from: 'you' })
  })

  it('a quote of a message that is not in the conversation is ignored, and the message still goes', async () => {
    await start()
    const mine = await user({ wallet_id: 'W-q-mine' })
    const other = await user({ wallet_id: 'W-q-other' })
    const secret = await sendFromApp(other, 'private to the other user')

    await sendFromApp(mine, 'quoting a stranger', { reply_to: secret.server_id })
    await sendFromApp(mine, 'quoting nothing real', { reply_to: 'm_does_not_exist' })
    const s = await h.subject('W-q-mine')
    const stored = await h.gw.store.listAfter(s.conversation.id, 0, 10)
    expect(stored.map((m) => [m.text, m.reply_to])).toEqual([['quoting a stranger', null], ['quoting nothing real', null]])

    // the same goes for Halo quoting an id from another user's conversation
    await fromHalo('W-q-mine', 'from support', { reply_to_server_id: secret.server_id })
    expect((await h.gw.store.listAfter(s.conversation.id, 0, 10)).at(-1)!.reply_to).toBeNull()
  })

  it('a quote survives a reconnect: it is replayed with the message', async () => {
    await start()
    const client = await user({ wallet_id: 'W-replay-quote' })
    const asked = await sendFromApp(client, 'a question')
    await fromHalo('W-replay-quote', 'an answer', { reply_to_server_id: asked.server_id })
    client.close()
    await vi.waitFor(() => expect(h.gw.hub.size).toBe(0))
    const back = await user({ wallet_id: 'W-replay-quote' }, { last_seq: 0 })
    const replayed: Record<string, unknown>[] = []
    for (let i = 0; i < 2; i++) replayed.push(await back.next('deliver'))
    expect(replayed[1]!.reply_to).toMatchObject({ server_id: asked.server_id, text: 'a question' })
    expect(replayed[0]!.reply_to).toBeNull()
  })

  it('refuses a reply_to that is not an id', async () => {
    await start()
    const client = await user()
    client.send({ type: 'send', client_id: 'c', kind: 'text', text: 'x', reply_to: 42 })
    expect(await client.next('error')).toMatchObject({ code: 'bad_frame' })
  })
})

describe('typing', () => {
  it('the app\'s typing reaches Halo as a signed, ephemeral event', async () => {
    await start()
    const client = await user({ wallet_id: 'W-typing' })
    client.send({ type: 'typing' })
    await vi.waitFor(() => expect(received.some((r) => r.json.event === 'user.typing')).toBe(true))
    const r = received.find((x) => x.json.event === 'user.typing')!
    expect(r.json).toMatchObject({ event: 'user.typing', event_id: expect.stringMatching(/^evt_/), workspace_key: WORKSPACE.key, user: { wallet_id: 'W-typing' }, conversation_id: expect.stringMatching(/^c_/) })
    expect(r.headers.get('x-vircle-signature')).toBe(signBody(WORKSPACE.signingSecret, r.headers.get('x-vircle-timestamp')!, r.raw))
    // ephemeral: nothing was queued
    expect(await h.gw.store.pendingEvents(h.workspace.id)).toEqual([])
  })

  it('tells Halo at most once every few seconds per user, but each user separately', async () => {
    await start()
    const a = await user({ wallet_id: 'W-typing-a' })
    const b = await user({ wallet_id: 'W-typing-b' })
    for (let i = 0; i < 5; i++) a.send({ type: 'typing' })
    b.send({ type: 'typing' })
    a.send({ type: 'ping' })
    await a.next('pong')
    await vi.waitFor(() => expect(received.filter((r) => r.json.event === 'user.typing')).toHaveLength(2))
    await new Promise((r) => setTimeout(r, 100))
    expect(received.filter((r) => r.json.event === 'user.typing')).toHaveLength(2)
  })

  it('is not retried when Halo is down, and never disturbs the connection', async () => {
    await start()
    haloStatus = 503
    const client = await user({ wallet_id: 'W-typing-down' })
    client.send({ type: 'typing' })
    await vi.waitFor(() => expect(received.some((r) => r.json.event === 'user.typing')).toBe(true))
    expect(await h.gw.store.pendingEvents(h.workspace.id)).toEqual([])
    client.send({ type: 'ping', t: 1 })
    expect(await client.next('pong')).toMatchObject({ t: 1 })
    expect(client.frames.filter((f) => f.type === 'error')).toEqual([])
  })

  it('an agent\'s typing from Halo shows in every open app, and nowhere else', async () => {
    await start()
    const phone = await user({ wallet_id: 'W-agent-typing' }, { device_id: 'phone' })
    const tablet = await user({ wallet_id: 'W-agent-typing' }, { device_id: 'tablet' })
    const bystander = await user({ wallet_id: 'W-bystander' })
    const res = await post('/v1/typing', { recipient: { wallet_id: 'W-agent-typing' } })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ delivered_to: 2 })
    expect(await phone.next('typing')).toMatchObject({ conversation_id: expect.stringMatching(/^c_/), from: 'support' })
    await tablet.next('typing')
    await new Promise((r) => setTimeout(r, 50))
    expect(bystander.frames.filter((f) => f.type === 'typing')).toEqual([])
  })

  it('answers 0 for a closed app or an unknown user, stores nothing, and sends no push', async () => {
    await start()
    expect(await (await post('/v1/typing', { recipient: { wallet_id: 'W-nobody-typing' } })).json()).toEqual({ delivered_to: 0 })
    await fromHalo('W-closed-typing', 'hello') // creates the user, offline
    const before = h.push.sent.length
    expect(await (await post('/v1/typing', { recipient: { wallet_id: 'W-closed-typing' } })).json()).toEqual({ delivered_to: 0 })
    expect(h.push.sent.length).toBe(before)
    expect(await h.gw.store.findSubjectByWallet(h.workspace, 'W-nobody-typing')).toBeNull()
  })

  it('needs Halo\'s token and a wallet id', async () => {
    await start()
    expect((await post('/v1/typing', { recipient: { wallet_id: 'W' } }, null)).status).toBe(401)
    expect((await post('/v1/typing', { recipient: { wallet_id: 'W' } }, h.sessionsKey)).status).toBe(401)
    expect((await post('/v1/typing', {})).status).toBe(400)
  })
})
