import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ pinned: vi.fn() }))
vi.mock('@/lib/net/safe-fetch', () => ({ pinnedFetch: h.pinned }))

import { checkGatewayHealth, GatewayError, normalizeGatewayUrl, sendToGateway } from './gateway'

const conn = { baseUrl: 'https://gw.example.com', apiToken: 'tok' }
const msg = {
  idempotencyKey: 'halo-msg-1',
  walletId: 'W1',
  contact: { name: 'Aisha', phone: '+60123456789', email: 'a@example.com' },
  conversationId: null as string | null,
  type: 'text' as const,
  text: 'Hi',
  media: null,
  senderName: 'Support',
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

beforeEach(() => h.pinned.mockReset())
afterEach(() => vi.unstubAllEnvs())

describe('normalizeGatewayUrl', () => {
  it('accepts https and drops a trailing slash', () => {
    expect(normalizeGatewayUrl(' https://gw.example.com/ ')).toEqual({ ok: true, url: 'https://gw.example.com' })
    expect(normalizeGatewayUrl('https://gw.example.com/chat/')).toEqual({ ok: true, url: 'https://gw.example.com/chat' })
  })

  it('refuses plain http, credentials, query, fragment and nonsense', () => {
    expect(normalizeGatewayUrl('http://gw.example.com')).toMatchObject({ ok: false })
    expect(normalizeGatewayUrl('https://u:p@gw.example.com')).toMatchObject({ ok: false })
    expect(normalizeGatewayUrl('https://gw.example.com/?a=1')).toMatchObject({ ok: false })
    expect(normalizeGatewayUrl('https://gw.example.com/#x')).toMatchObject({ ok: false })
    expect(normalizeGatewayUrl('not a url')).toMatchObject({ ok: false })
  })

  it('allows http://localhost only when the deployment allows a local gateway', () => {
    expect(normalizeGatewayUrl('http://localhost:4010')).toMatchObject({ ok: false })
    vi.stubEnv('VIRCLE_CHAT_ALLOW_LOCAL_GATEWAY', 'true')
    expect(normalizeGatewayUrl('http://localhost:4010')).toEqual({ ok: true, url: 'http://localhost:4010' })
    expect(normalizeGatewayUrl('http://gw.example.com')).toMatchObject({ ok: false })
  })
})

describe('sendToGateway', () => {
  it('posts the contract body with the token and idempotency key, and reads the 202', async () => {
    h.pinned.mockResolvedValue(json(202, { server_id: 'm_78', seq: 42, conversation_id: 'c_1', delivery: 'push' }))
    const out = await sendToGateway(conn, { ...msg, conversationId: 'c_1' })
    expect(out).toEqual({ serverId: 'm_78', seq: 42, conversationId: 'c_1', delivery: 'push' })

    const [url, init] = h.pinned.mock.calls[0]
    expect(url).toBe('https://gw.example.com/v1/messages')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ authorization: 'Bearer tok', 'idempotency-key': 'halo-msg-1' })
    expect(JSON.parse(init.body)).toEqual({
      recipient: { wallet_id: 'W1', name: 'Aisha', phone: '+60123456789', email: 'a@example.com' },
      type: 'text',
      conversation_id: 'c_1',
      text: 'Hi',
      sender: { name: 'Support' },
    })
  })

  it('sends a file as media with its fields, and omits what it does not have', async () => {
    h.pinned.mockResolvedValue(json(202, { server_id: 'm_1', delivery: 'socket' }))
    await sendToGateway(conn, {
      ...msg,
      type: 'image',
      text: null,
      senderName: null,
      contact: { name: null, phone: null, email: null },
      media: { url: 'https://signed.example/a.png', mimeType: 'image/png', fileName: null, sizeBytes: null },
    })
    expect(JSON.parse(h.pinned.mock.calls[0][1].body)).toEqual({
      recipient: { wallet_id: 'W1' },
      type: 'image',
      media: { url: 'https://signed.example/a.png', mime_type: 'image/png' },
    })
  })

  it('turns a refusal into a final GatewayError with the gateway\'s code', async () => {
    h.pinned.mockResolvedValue(json(404, { error: { code: 'user_not_found', message: 'No such user' } }))
    const err = await sendToGateway(conn, msg).catch((e) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect(err).toMatchObject({ code: 'user_not_found', message: 'No such user', status: 404, retryable: false })
  })

  it('marks 429 (with Retry-After) and 5xx as retryable', async () => {
    h.pinned.mockResolvedValueOnce(json(429, { error: { code: 'rate_limited', message: 'slow' } }, { 'retry-after': '7' }))
    expect(await sendToGateway(conn, msg).catch((e) => e)).toMatchObject({ retryable: true, retryAfterSeconds: 7, code: 'rate_limited' })
    h.pinned.mockResolvedValueOnce(json(503, 'down'))
    expect(await sendToGateway(conn, msg).catch((e) => e)).toMatchObject({ retryable: true, status: 503 })
  })

  it('treats a network failure as retryable and unreachable', async () => {
    h.pinned.mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
    expect(await sendToGateway(conn, msg).catch((e) => e)).toMatchObject({ code: 'unreachable', retryable: true, status: 0 })
  })

  it('does not trust a 202 that says nothing useful', async () => {
    h.pinned.mockResolvedValue(json(202, { ok: true }))
    expect(await sendToGateway(conn, msg).catch((e) => e)).toMatchObject({ code: 'bad_response', retryable: true })
  })
})

describe('checkGatewayHealth', () => {
  it('reports ok, a refused token, and an unreachable gateway', async () => {
    h.pinned.mockResolvedValueOnce(json(200, { ok: true }))
    expect(await checkGatewayHealth(conn)).toEqual({ ok: true })
    expect(h.pinned.mock.calls[0][0]).toBe('https://gw.example.com/v1/health')

    h.pinned.mockResolvedValueOnce(json(401, {}))
    expect(await checkGatewayHealth(conn)).toEqual({ ok: false, error: 'The gateway refused the API token' })

    h.pinned.mockRejectedValueOnce(new Error('boom'))
    expect(await checkGatewayHealth(conn)).toMatchObject({ ok: false })
  })
})
