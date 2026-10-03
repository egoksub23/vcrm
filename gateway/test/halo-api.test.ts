import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { connectUser, startHarness, TestClient, WORKSPACE, type Harness } from './helpers'

let h: Harness
const clients: TestClient[] = []

beforeAll(async () => {
  h = await startHarness()
})
afterAll(async () => {
  clients.forEach((c) => c.close())
  await h.close()
})

const send = (body: unknown, opts: { key?: string | null; token?: string | null; raw?: string } = {}) =>
  fetch(`${h.url}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.token === null ? {} : { authorization: `Bearer ${opts.token ?? WORKSPACE.apiToken}` }),
      ...(opts.key === null ? {} : { 'idempotency-key': opts.key ?? `key-${Math.random()}` }),
    },
    body: opts.raw ?? JSON.stringify(body),
  })

const text = (extra: Record<string, unknown> = {}) => ({
  recipient: { wallet_id: 'W-api', name: 'Aisha', phone: '+60123456789', email: 'Aisha@Example.com' },
  type: 'text',
  text: 'Hi Aisha, checking now.',
  sender: { name: 'Support' },
  ...extra,
})
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error

describe('GET /v1/health', () => {
  it('answers 200 to Halo with the right token, and 401 otherwise', async () => {
    const ok = await fetch(`${h.url}/v1/health`, { headers: { authorization: `Bearer ${WORKSPACE.apiToken}` } })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true })
    expect((await fetch(`${h.url}/v1/health`)).status).toBe(401)
    expect((await fetch(`${h.url}/v1/health`, { headers: { authorization: 'Bearer nope' } })).status).toBe(401)
    // the sessions key is a different credential and does not open Halo's door
    expect((await fetch(`${h.url}/v1/health`, { headers: { authorization: `Bearer ${h.sessionsKey}` } })).status).toBe(401)
  })
})

describe('POST /v1/messages', () => {
  it('stores the message, numbers it, and answers 202 in the contract\'s shape', async () => {
    const res = await send(text(), { key: 'halo-msg-1' })
    expect(res.status).toBe(202)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({ server_id: expect.stringMatching(/^m_/), seq: 1, conversation_id: expect.stringMatching(/^c_/), delivery: 'push' })
    const s = await h.subject('W-api')
    const [stored] = await h.gw.store.listAfter(s.conversation.id, 0, 10)
    expect(stored).toMatchObject({ direction: 'out', text: 'Hi Aisha, checking now.', sender_name: 'Support', idempotency_key: 'halo-msg-1', delivery: 'push' })
    expect(s.user).toMatchObject({ name: 'Aisha', phone: '+60123456789', email: 'aisha@example.com' })
  })

  it('creates the user for someone who has never opened the chat, so the message waits for them', async () => {
    const res = await send(text({ recipient: { wallet_id: 'W-never-seen', phone: '+60111111111' } }))
    expect(res.status).toBe(202)
    const s = await h.subject('W-never-seen')
    expect(s.user.phone).toBe('+60111111111')
    expect(s.conversation.last_seq).toBe(1)
  })

  it('answers a repeated Idempotency-Key with the same answer and stores one message', async () => {
    const first = (await (await send(text({ recipient: { wallet_id: 'W-idem' } }), { key: 'same-key' })).json()) as Record<string, unknown>
    const secondRes = await send(text({ recipient: { wallet_id: 'W-idem' }, text: 'a different text' }), { key: 'same-key' })
    expect(secondRes.status).toBe(202)
    expect(await secondRes.json()).toEqual(first)
    const s = await h.subject('W-idem')
    const stored = await h.gw.store.listAfter(s.conversation.id, 0, 10)
    expect(stored).toHaveLength(1)
    expect(stored[0]!.text).toBe('Hi Aisha, checking now.')
  })

  it('numbers messages from Halo and from the app in one sequence', async () => {
    const { client } = await connectUser(h, { wallet_id: 'W-seq' })
    clients.push(client)
    client.send({ type: 'send', client_id: 'c1', kind: 'text', text: 'from the app' })
    await client.next('ack')
    const res = await send(text({ recipient: { wallet_id: 'W-seq' } }))
    expect(((await res.json()) as { seq: number }).seq).toBe(2)
  })

  describe('refusals', () => {
    it('401 for a missing, wrong or sessions-key token', async () => {
      for (const token of [null, 'wrong', h.sessionsKey]) {
        const res = await send(text(), { token })
        expect(res.status).toBe(401)
        expect((await errorOf(res)).code).toBe('unauthorized')
      }
    })

    it('400 without an Idempotency-Key', async () => {
      const res = await send(text(), { key: null })
      expect(res.status).toBe(400)
      expect((await errorOf(res)).message).toMatch(/Idempotency-Key/)
    })

    it('400 without a wallet id, with a bad type, with no text', async () => {
      expect((await send(text({ recipient: {} }))).status).toBe(400)
      expect((await send({ type: 'text', text: 'x' })).status).toBe(400)
      expect((await send(text({ type: 'sticker' }))).status).toBe(400)
      expect((await send(text({ text: '   ' }))).status).toBe(400)
      expect((await send(text({ text: undefined }))).status).toBe(400)
    })

    it('message_too_long over the text limit, and accepts exactly the limit', async () => {
      const long = await send(text({ text: 'x'.repeat(4001) }))
      expect(long.status).toBe(400)
      expect((await errorOf(long)).code).toBe('message_too_long')
      expect((await send(text({ recipient: { wallet_id: 'W-limit' }, text: 'x'.repeat(4000) }))).status).toBe(202)
    })

    it('invalid_media for a file the gateway may not fetch (an address that is not https)', async () => {
      const res = await send(text({ type: 'image', media: { url: 'http://files.example.com/a.jpg', mime_type: 'image/jpeg' } }))
      expect(res.status).toBe(400)
      expect((await errorOf(res)).code).toBe('invalid_media')
    })

    it('400 for a body that is not JSON, 413 for one that is far too large', async () => {
      expect((await send(null, { raw: '{broken' })).status).toBe(400)
      expect((await send(text({ text: 'x'.repeat(200_000) }))).status).toBe(413)
    })

    it('stores nothing for a refused message', async () => {
      await send(text({ recipient: { wallet_id: 'W-refused' }, text: 'x'.repeat(4001) }))
      expect(await h.gw.store.findSubjectByWallet(h.workspace, 'W-refused')).toBeNull()
    })
  })

  describe('what Halo knows about the contact', () => {
    it('drops a malformed email or an over-long phone instead of refusing the message', async () => {
      const res = await send(text({ recipient: { wallet_id: 'W-lenient', email: 'not an email', phone: '9'.repeat(100), name: 'Sam' } }))
      expect(res.status).toBe(202)
      const s = await h.subject('W-lenient')
      expect(s.user).toMatchObject({ name: 'Sam', email: null, phone: null })
    })

    it('does not blank what the gateway already knows when a later message leaves it out', async () => {
      await send(text({ recipient: { wallet_id: 'W-keeps', name: 'Nur', phone: '+60122222222' } }))
      await send(text({ recipient: { wallet_id: 'W-keeps' } }))
      expect((await h.subject('W-keeps')).user).toMatchObject({ name: 'Nur', phone: '+60122222222' })
    })
  })

  describe('delivery', () => {
    it('is "socket" when the user has a live connection, and the app gets the message at once', async () => {
      const { client } = await connectUser(h, { wallet_id: 'W-live' })
      clients.push(client)
      const res = await send(text({ recipient: { wallet_id: 'W-live' }, text: 'are you there?' }))
      const body = (await res.json()) as { server_id: string; seq: number; delivery: string }
      expect(body.delivery).toBe('socket')
      expect(await client.next('deliver')).toMatchObject({ server_id: body.server_id, seq: body.seq, direction: 'out', text: 'are you there?', sender: { name: 'Support' }, status: 'sent' })
    })

    it('is "queued" when the user is offline, and the message is replayed when they connect', async () => {
      const res = await send(text({ recipient: { wallet_id: 'W-away' }, text: 'when you are back' }))
      expect(((await res.json()) as { delivery: string }).delivery).toBe('queued')
      const { token } = await h.session({ wallet_id: 'W-away' })
      const client = await TestClient.connect(h.gw.port)
      clients.push(client)
      client.hello(token, { last_seq: 0 })
      await client.next('welcome')
      expect(await client.next('deliver')).toMatchObject({ text: 'when you are back', direction: 'out' })
      await client.next('resume_done')
    })

    it('reaches every device the user has connected', async () => {
      const a = await connectUser(h, { wallet_id: 'W-two' }, { device_id: 'phone' })
      const b = await connectUser(h, { wallet_id: 'W-two' }, { device_id: 'tablet' })
      clients.push(a.client, b.client)
      await send(text({ recipient: { wallet_id: 'W-two' }, text: 'both of you' }))
      expect((await a.client.next('deliver')).text).toBe('both of you')
      expect((await b.client.next('deliver')).text).toBe('both of you')
    })

    it('repeats the first answer for a duplicate even after the user has connected', async () => {
      const first = (await (await send(text({ recipient: { wallet_id: 'W-later' } }), { key: 'later-1' })).json()) as { delivery: string }
      expect(first.delivery).toBe('queued')
      const { client } = await connectUser(h, { wallet_id: 'W-later' })
      clients.push(client)
      const again = (await (await send(text({ recipient: { wallet_id: 'W-later' } }), { key: 'later-1' })).json()) as { delivery: string }
      expect(again.delivery).toBe('queued')
      // and the duplicate is not delivered a second time
      await new Promise((r) => setTimeout(r, 50))
      expect(client.frames.filter((f) => f.type === 'deliver')).toEqual([])
    })
  })
})
