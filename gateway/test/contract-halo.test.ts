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

import { checkGatewayHealth, GatewayError, normalizeGatewayUrl, sendToGateway } from '../../src/lib/vircle-chat/gateway'
import { parseWebhookEvent } from '../../src/lib/vircle-chat/contract'
import { verifySignature } from '../../src/lib/vircle-chat/signing'
import { connectUser, startHarness, WORKSPACE, type Harness, type TestClient } from './helpers'

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
    expect(accepted).toMatchObject({ serverId: expect.stringMatching(/^m_/), seq: 1, conversationId: expect.stringMatching(/^c_/), delivery: 'queued' })
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
      outbound({ type: 'image', text: null, media: { url: 'https://files.example.com/a.jpg', mimeType: 'image/jpeg', fileName: null, sizeBytes: null } }),
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
