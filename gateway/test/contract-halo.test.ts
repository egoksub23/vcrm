// The gateway against HALO'S OWN code, not against a re-reading of the contract.
//
//   gateway -> Halo : every event the gateway sends is checked with Halo's `verifySignature` and read
//                     with Halo's `parseWebhookEvent`, exactly as Halo's webhook route does.
//   Halo -> gateway : Halo's own `sendToGateway` and `checkGatewayHealth` call this gateway and read
//                     the answers with Halo's own parsers.
//
// If either side changes in a way that breaks the other, this file fails. It imports Halo's source
// through the "@" alias in vitest.config.ts and is excluded from this package's `tsc` (Halo has its
// own tsconfig); vitest still runs it.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { checkGatewayHealth, GatewayError, normalizeGatewayUrl, sendReadReceipts, sendToGateway, sendTyping } from '../../src/lib/vircle-chat/gateway'
import { parseWebhookEvent } from '../../src/lib/vircle-chat/contract'
import { verifySignature } from '../../src/lib/vircle-chat/signing'
import { allowLocalFetch, connectUser, MP4, OGG, PNG, startFileServer, startHarness, uploadFile, WORKSPACE, type FileServer, type Harness, type TestClient } from './helpers'

interface Received {
  headers: Headers
  raw: string
}

let h: Harness
let received: Received[]
let walletCounter = 0
const clients: TestClient[] = []

beforeAll(async () => {
  vi.stubEnv('VIRCLE_CHAT_ALLOW_LOCAL_GATEWAY', 'true')
  received = []
  h = await startHarness({
    cfg: allowLocalFetch(),
    dispatcher: {
      // Halo's endpoint, as far as the gateway can tell: it records what it was sent and answers 200.
      fetch: (async (_url: string, init: RequestInit) => {
        received.push({ headers: new Headers(init.headers), raw: String(init.body) })
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }) as unknown as typeof fetch,
    },
  })
})
afterAll(async () => {
  clients.forEach((c) => c.close())
  await h.close()
  vi.unstubAllEnvs()
})

const conn = () => ({ baseUrl: h.url, apiToken: WORKSPACE.apiToken })
const outbound = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: `halo-${Math.random()}`,
  walletId: 'W-contract',
  contact: { name: 'Aisha', phone: '+60123456789', email: 'aisha@example.com' },
  conversationId: null,
  type: 'text' as const,
  text: 'Hi Aisha, checking now.',
  media: null,
  senderName: 'Support',
  ...over,
})

describe('Halo -> gateway, with Halo\'s own client', () => {
  it('accepts the gateway address Halo\'s settings screen would accept', () => {
    expect(normalizeGatewayUrl(h.url)).toEqual({ ok: true, url: h.url })
  })

  it('"Test connection" succeeds with the API token and fails with a wrong one', async () => {
    expect(await checkGatewayHealth(conn())).toEqual({ ok: true })
    expect(await checkGatewayHealth({ ...conn(), apiToken: 'wrong' })).toEqual({ ok: false, error: 'The gateway refused the API token' })
  })

  it('sends a message and reads the answer: server id, sequence, conversation, delivery', async () => {
    const accepted = await sendToGateway(conn(), outbound())
    expect(accepted).toMatchObject({ serverId: expect.stringMatching(/^m_/), seq: 1, conversationId: expect.stringMatching(/^c_/), delivery: 'push' })
  })

  it('a repeated send with the same idempotency key gets the same answer', async () => {
    const msg = outbound({ idempotencyKey: 'halo-same', walletId: 'W-contract-idem' })
    expect(await sendToGateway(conn(), msg)).toEqual(await sendToGateway(conn(), msg))
  })

  it('reaches a live app: "socket", and the app sees the message', async () => {
    const { client } = await connectUser(h, { wallet_id: 'W-contract-live' })
    clients.push(client)
    const accepted = await sendToGateway(conn(), outbound({ walletId: 'W-contract-live', text: 'live one' }))
    expect(accepted.delivery).toBe('socket')
    expect(await client.next('deliver')).toMatchObject({ server_id: accepted.serverId, text: 'live one', sender: { name: 'Support' } })
  })

  it('turns the gateway\'s refusals into errors Halo understands, with the right retry flag', async () => {
    const tooLong = await sendToGateway(conn(), outbound({ text: 'x'.repeat(4001) })).catch((e) => e)
    expect(tooLong).toBeInstanceOf(GatewayError)
    expect(tooLong).toMatchObject({ code: 'message_too_long', status: 400, retryable: false })

    const unauthorized = await sendToGateway({ ...conn(), apiToken: 'wrong' }, outbound()).catch((e) => e)
    expect(unauthorized).toMatchObject({ code: 'unauthorized', status: 401, retryable: false })

    const media = await sendToGateway(
      conn(),
      outbound({ type: 'image', text: null, media: { url: 'http://files.example.com/a.jpg', mimeType: 'image/jpeg', fileName: null, sizeBytes: null } }),
    ).catch((e) => e)
    expect(media).toMatchObject({ code: 'invalid_media', retryable: false })
  })

  it('tells Halo to retry when the gateway cannot be reached', async () => {
    const err = await sendToGateway({ baseUrl: 'http://127.0.0.1:1', apiToken: 'x' }, outbound()).catch((e) => e)
    expect(err).toMatchObject({ code: 'unreachable', retryable: true })
  })
})

describe('gateway -> Halo, checked with Halo\'s own code', () => {
  async function eventsFromARealConversation() {
    received.length = 0
    walletCounter++
    const wallet = `W-contract-events-${walletCounter}`
    const { client } = await connectUser(h, { wallet_id: wallet, name: 'Aisha', phone: '+60123456789', email: 'aisha@example.com' })
    clients.push(client)
    client.send({ type: 'send', client_id: 'cid-1', kind: 'text', text: 'Hi, I cannot top up' })
    await client.next('ack')
    const accepted = await sendToGateway(conn(), outbound({ walletId: wallet }))
    await client.next('deliver')
    client.send({ type: 'receipt', up_to_seq: accepted.seq ?? 0, status: 'delivered' })
    client.send({ type: 'receipt', up_to_seq: accepted.seq ?? 0, status: 'read' })
    await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(3), { timeout: 5000 })
    return { accepted, sent: [...received] }
  }

  it('every event passes Halo\'s signature check with the workspace\'s secret, and fails with another', async () => {
    const { sent } = await eventsFromARealConversation()
    for (const { headers, raw } of sent) {
      const check = (secret: string) =>
        verifySignature({
          secret,
          timestampHeader: headers.get('x-vircle-timestamp'),
          signatureHeader: headers.get('x-vircle-signature'),
          rawBody: raw,
        })
      expect(check(WORKSPACE.signingSecret)).toBe('ok')
      expect(check('vcs_some_other_secret')).toBe('bad_signature')
    }
  })

  it('a tampered body fails the signature', async () => {
    const { sent } = await eventsFromARealConversation()
    const { headers, raw } = sent[0]!
    expect(
      verifySignature({
        secret: WORKSPACE.signingSecret,
        timestampHeader: headers.get('x-vircle-timestamp'),
        signatureHeader: headers.get('x-vircle-signature'),
        rawBody: raw.replace('top up', 'TOP UP'),
      }),
    ).toBe('bad_signature')
  })

  it('the inbound event is read by Halo\'s parser with the user\'s identity and the message', async () => {
    const { sent } = await eventsFromARealConversation()
    const inbound = sent.map((r) => parseWebhookEvent(JSON.parse(r.raw))).find((p) => p.ok && 'event' in p && p.event.kind === 'message.inbound')
    expect(inbound).toBeTruthy()
    expect(inbound).toMatchObject({
      ok: true,
      event: {
        kind: 'message.inbound',
        eventId: expect.stringMatching(/^evt_/),
        workspaceKey: WORKSPACE.key,
        user: { walletId: expect.stringMatching(/^W-contract-events-/), name: 'Aisha', phone: '+60123456789', email: 'aisha@example.com' },
        conversationId: expect.stringMatching(/^c_/),
        message: { serverId: expect.stringMatching(/^m_/), clientId: 'cid-1', type: 'text', text: 'Hi, I cannot top up' },
      },
    })
  })

  it('the receipts are read by Halo\'s parser, naming the message Halo sent', async () => {
    const { accepted, sent } = await eventsFromARealConversation()
    const receipts = sent.map((r) => parseWebhookEvent(JSON.parse(r.raw))).filter((p) => p.ok && 'event' in p && p.event.kind === 'message.receipt')
    expect(receipts.length).toBeGreaterThanOrEqual(2)
    for (const r of receipts) expect(r).toMatchObject({ ok: true, event: { kind: 'message.receipt', serverId: accepted.serverId } })
    expect(receipts.map((r) => (r as { event: { status: string } }).event.status)).toEqual(['delivered', 'read'])
  })

  it('sends events in the order they happened: the user\'s message, then the receipts', async () => {
    const { sent } = await eventsFromARealConversation()
    expect(sent.map((r) => (JSON.parse(r.raw) as { event: string }).event).slice(0, 3)).toEqual(['message.inbound', 'message.receipt', 'message.receipt'])
  })
})

describe('contract 1.2, with Halo own code on both sides', () => {
  let files: FileServer | null = null
  afterAll(async () => files?.close())

  const events = () => received.map((r) => JSON.parse(r.raw) as Record<string, any>)

  it('Halo read receipts reach the app as "read", and Halo client reads the count back', async () => {
    const wallet = `W-contract-read-${++walletCounter}`
    const { client } = await connectUser(h, { wallet_id: wallet })
    clients.push(client)
    client.send({ type: 'send', client_id: 'c1', kind: 'text', text: 'please look at this' })
    const ack = await client.next('ack')
    await client.next('receipt') // delivered, once Halo accepted the event
    expect(await sendReadReceipts(conn(), wallet, [ack.server_id as string])).toBe(1)
    expect(await client.next('receipt')).toMatchObject({ status: 'read', messages: [{ server_id: ack.server_id }] })
    expect(await sendReadReceipts(conn(), wallet, [ack.server_id as string])).toBe(0)
    await expect(sendReadReceipts({ ...conn(), apiToken: 'wrong' }, wallet, ['m_1'])).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('Halo typing signal reaches the app', async () => {
    const wallet = `W-contract-typing-${++walletCounter}`
    const { client } = await connectUser(h, { wallet_id: wallet })
    clients.push(client)
    expect(await sendTyping(conn(), wallet)).toBe(1)
    expect(await client.next('typing')).toMatchObject({ from: 'support' })
    expect(await sendTyping(conn(), 'W-nobody-at-all')).toBe(0)
  })

  it('the app typing is a user.typing event Halo parser accepts, signature included', async () => {
    const wallet = `W-contract-typing-up-${++walletCounter}`
    const { client } = await connectUser(h, { wallet_id: wallet })
    clients.push(client)
    received.length = 0
    client.send({ type: 'typing' })
    await vi.waitFor(() => expect(events().some((e) => e.event === 'user.typing')).toBe(true))
    const r = received.find((x) => JSON.parse(x.raw).event === 'user.typing')!
    expect(verifySignature({ secret: WORKSPACE.signingSecret, timestampHeader: r.headers.get('x-vircle-timestamp'), signatureHeader: r.headers.get('x-vircle-signature'), rawBody: r.raw })).toBe('ok')
    expect(parseWebhookEvent(JSON.parse(r.raw))).toMatchObject({ ok: true, event: { kind: 'user.typing', walletId: wallet, workspaceKey: WORKSPACE.key } })
  })

  it('a reply and a voice note from the app are read by Halo parser: the quote, the file link and its length', async () => {
    const wallet = `W-contract-file-${++walletCounter}`
    const { client } = await connectUser(h, { wallet_id: wallet })
    clients.push(client)
    const asked = await sendToGateway(conn(), outbound({ walletId: wallet, text: 'How can we help?' }))
    await client.next('deliver')
    received.length = 0

    const { slot } = await uploadFile(client, { kind: 'audio', mime: 'audio/ogg', name: 'note.ogg', bytes: OGG, durationSeconds: 9 })
    client.send({ type: 'send', client_id: 'c-voice', kind: 'audio', media: { file_id: slot.file_id }, reply_to: asked.serverId })
    await client.next('ack')
    await vi.waitFor(() => expect(events().some((e) => e.event === 'message.inbound')).toBe(true))
    const sent = events().find((e) => e.event === 'message.inbound')!
    // Halo accepts only https addresses; in production the gateway is behind https, here it is on 127.0.0.1.
    const parsed = parseWebhookEvent({ ...sent, message: { ...sent.message, media: { ...sent.message.media, url: sent.message.media.url.replace('http://', 'https://') } } })
    expect(parsed).toMatchObject({
      ok: true,
      event: {
        kind: 'message.inbound',
        message: { type: 'audio', replyToServerId: asked.serverId, media: { mimeType: 'audio/ogg', fileName: 'note.ogg', durationSeconds: 9 } },
      },
    })
    // the address in the event is one Halo can fetch, and it serves the file
    expect(Buffer.from(await (await fetch(sent.message.media.url)).arrayBuffer()).equals(OGG)).toBe(true)
  })

  it('Halo file send, with a quote and a voice-note length, is fetched and shown in the app', async () => {
    files = await startFileServer({ '/photo.png': { type: 'image/png', body: PNG } })
    const wallet = `W-contract-halo-file-${++walletCounter}`
    const { client } = await connectUser(h, { wallet_id: wallet })
    clients.push(client)
    client.send({ type: 'send', client_id: 'c-q', kind: 'text', text: 'what does it look like?' })
    const asked = await client.next('ack')
    const accepted = await sendToGateway(
      conn(),
      outbound({
        walletId: wallet,
        type: 'image',
        text: 'like this',
        replyToServerId: asked.server_id,
        media: { url: files.url('/photo.png'), mimeType: 'image/png', fileName: 'photo.png', sizeBytes: PNG.length },
      }),
    )
    expect(accepted.delivery).toBe('socket')
    const frame = await client.next('deliver', (f) => f.direction === 'out')
    expect(frame).toMatchObject({ kind: 'image', text: 'like this', reply_to: { server_id: asked.server_id, text: 'what does it look like?', from: 'you' }, media: { mime_type: 'image/png', file_name: 'photo.png' } })
  })

  it('a GIF from the app (an animated MP4) is read by Halo parser as animated, and Halo can fetch it', async () => {
    const wallet = `W-contract-gif-${++walletCounter}`
    const { client } = await connectUser(h, { wallet_id: wallet })
    clients.push(client)
    received.length = 0
    const { slot } = await uploadFile(client, { kind: 'video', mime: 'video/mp4', name: 'cat.mp4', bytes: MP4, animated: true })
    client.send({ type: 'send', client_id: 'c-gif', kind: 'video', media: { file_id: slot.file_id } })
    await client.next('ack')
    await vi.waitFor(() => expect(events().some((e) => e.event === 'message.inbound')).toBe(true))
    const sent = events().find((e) => e.event === 'message.inbound')!
    const parsed = parseWebhookEvent({ ...sent, message: { ...sent.message, media: { ...sent.message.media, url: sent.message.media.url.replace('http://', 'https://') } } })
    expect(parsed).toMatchObject({ ok: true, event: { message: { type: 'video', media: { mimeType: 'video/mp4', animated: true } } } })
    expect(Buffer.from(await (await fetch(sent.message.media.url)).arrayBuffer()).equals(MP4)).toBe(true)
  })

  // Emoji are just text, but the places they can break are exactly the places this test crosses: JSON, signing, the
  // database, and any length count. Skin tones, joined families, flags, keycaps and a heart on fire are several code
  // points each (and astral, so two UTF-16 units per code point); other scripts ride along.
  const EMOJI_TEXT = '👍🏽 👨‍👩‍👧‍👦 🇲🇾 1️⃣ ❤️‍🔥 😀 مرحبا 你好 안녕 🧑🏻‍💻'

  it('emoji in a message from the app reach Halo byte for byte, through the signature and Halo parser', async () => {
    const wallet = `W-contract-emoji-up-${++walletCounter}`
    const { client } = await connectUser(h, { wallet_id: wallet })
    clients.push(client)
    received.length = 0
    client.send({ type: 'send', client_id: 'c-emoji', kind: 'text', text: EMOJI_TEXT })
    await client.next('ack')
    await vi.waitFor(() => expect(events().some((e) => e.event === 'message.inbound')).toBe(true))
    const r = received.find((x) => JSON.parse(x.raw).event === 'message.inbound')!
    expect(verifySignature({ secret: WORKSPACE.signingSecret, timestampHeader: r.headers.get('x-vircle-timestamp'), signatureHeader: r.headers.get('x-vircle-signature'), rawBody: r.raw })).toBe('ok')
    expect(parseWebhookEvent(JSON.parse(r.raw))).toMatchObject({ ok: true, event: { message: { text: EMOJI_TEXT } } })
  })

  it('emoji in a message from Halo reach the app byte for byte, and in the quote of a reply', async () => {
    const wallet = `W-contract-emoji-down-${++walletCounter}`
    const { client } = await connectUser(h, { wallet_id: wallet })
    clients.push(client)
    const first = await sendToGateway(conn(), outbound({ walletId: wallet, text: EMOJI_TEXT }))
    expect((await client.next('deliver', (f) => f.direction === 'out')).text).toBe(EMOJI_TEXT)
    await sendToGateway(conn(), outbound({ walletId: wallet, text: 'ok 👌', replyToServerId: first.serverId }))
    expect(await client.next('deliver', (f) => f.direction === 'out')).toMatchObject({ text: 'ok 👌', reply_to: { text: EMOJI_TEXT } })
  })

  it('counts a long emoji message by characters the way people do not: 4,000 UTF-16 units is the limit, and a message of 2,000 emoji fits', async () => {
    const wallet = `W-contract-emoji-len-${++walletCounter}`
    const { client } = await connectUser(h, { wallet_id: wallet })
    clients.push(client)
    client.send({ type: 'send', client_id: 'c-2000', kind: 'text', text: '😀'.repeat(2000) }) // 4,000 UTF-16 units
    expect(await client.next('ack')).toMatchObject({ client_id: 'c-2000' })
    client.send({ type: 'send', client_id: 'c-2001', kind: 'text', text: '😀'.repeat(2001) })
    expect(await client.next('error')).toMatchObject({ code: 'message_too_long' })
  })

  it('a file the gateway may not fetch comes back as the error Halo already understands', async () => {
    const err = await sendToGateway(conn(), outbound({ type: 'image', media: { url: 'http://127.0.0.1:1/none.png', mimeType: 'image/png', fileName: null, sizeBytes: null } })).catch((e) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect(err).toMatchObject({ code: 'invalid_media', retryable: false })
  })
})
