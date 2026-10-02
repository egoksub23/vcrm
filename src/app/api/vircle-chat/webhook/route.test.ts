import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  seen: false,
  eventsUpserts: [] as Record<string, unknown>[],
  configUpdates: [] as Record<string, unknown>[],
  enabled: true,
  limited: false,
  badLimited: false,
  badCount: vi.fn(),
  ingest: vi.fn(),
  receipt: vi.fn(),
  fanOut: vi.fn(),
  afterCallbacks: [] as (() => unknown)[],
}))

vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => h.afterCallbacks.push(fn),
}))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        lt: () => b,
        maybeSingle: async () => ({ data: table === 'vircle_chat_events' && h.seen ? { event_id: 'x' } : null, error: null }),
        upsert: async (row: Record<string, unknown>) => {
          h.eventsUpserts.push(row)
          return { error: null }
        },
        update: (row: Record<string, unknown>) => {
          if (table === 'vircle_chat_config') h.configUpdates.push(row)
          return b
        },
        delete: () => b,
        then: (resolve: (r: unknown) => unknown) => resolve({ error: null }),
      }
      return b
    },
  }),
}))
vi.mock('@/lib/net/client-ip', () => ({ clientIp: () => '203.0.113.9' }))
vi.mock('@/lib/rate-limit', () => ({
  isRateLimited: () => h.badLimited,
  checkRateLimit: (...a: unknown[]) => h.badCount(...a),
  RATE_LIMITS: { webhookInvalid: { limit: 1, windowMs: 1 }, vircleInbound: { limit: 1, windowMs: 1 } },
}))
vi.mock('@/lib/rate-limit-shared', () => ({
  checkSharedRateLimit: async () => ({ success: !h.limited, remaining: 0, reset: Date.now() + 5000, limit: 1 }),
}))
vi.mock('@/lib/vircle-chat/config', () => ({
  findConfigByKey: async () => h.row,
  openConfig: () => ({ signingSecret: 'vcs_secret', apiToken: 'tok' }),
}))
vi.mock('@/lib/vircle-chat/feature', () => ({ vircleChatEnabled: async () => h.enabled }))
vi.mock('@/lib/vircle-chat/events', () => ({
  ingestInbound: (...a: unknown[]) => h.ingest(...a),
  applyReceipt: (...a: unknown[]) => h.receipt(...a),
}))

import { signBody } from '@/lib/vircle-chat/signing'
import { POST } from './route'

const inboundBody = {
  event: 'message.inbound',
  event_id: 'evt_1',
  workspace_key: 'vcw_abcdefghijklmnop1234',
  user: { wallet_id: 'W123', name: 'Aisha' },
  conversation_id: 'c_1',
  message: { server_id: 'm_1', type: 'text', text: 'Hi' },
}

function request(body: unknown, opts: { secret?: string; timestamp?: number; raw?: string; headers?: Record<string, string> } = {}) {
  const raw = opts.raw ?? JSON.stringify(body)
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1000)
  return new Request('https://halo.example.com/api/vircle-chat/webhook', {
    method: 'POST',
    body: raw,
    headers: {
      'x-vircle-timestamp': String(ts),
      'x-vircle-signature': signBody(opts.secret ?? 'vcs_secret', ts, raw),
      ...opts.headers,
    },
  })
}

beforeEach(() => {
  h.row = { id: 'vc-1', account_id: 'acct-1', enabled: true, signing_secret: 'enc', api_token: 'enc' }
  h.seen = false
  h.eventsUpserts = []
  h.configUpdates = []
  h.enabled = true
  h.limited = false
  h.badLimited = false
  h.afterCallbacks = []
  h.badCount.mockReset()
  h.ingest.mockReset()
  h.receipt.mockReset()
  h.fanOut.mockReset()
  h.fanOut.mockResolvedValue(undefined)
  h.ingest.mockResolvedValue({ status: 'stored', messageId: 'msg-1', contactId: 'c', conversationId: 'cv', fanOut: h.fanOut })
  h.receipt.mockResolvedValue({ status: 'updated' })
})

describe('POST /api/vircle-chat/webhook: who may call', () => {
  it('turns away an address that keeps failing, before reading anything', async () => {
    h.badLimited = true
    const res = await POST(request(inboundBody))
    expect(res.status).toBe(429)
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('rejects a wrong signature and counts it against the caller', async () => {
    const res = await POST(request(inboundBody, { secret: 'someone-elses' }))
    expect(res.status).toBe(401)
    expect(h.badCount).toHaveBeenCalled()
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('rejects an unknown workspace key exactly like a wrong signature', async () => {
    h.row = null
    const res = await POST(request(inboundBody))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Invalid signature' })
  })

  it('rejects a request outside the five-minute window', async () => {
    const res = await POST(request(inboundBody, { timestamp: Math.floor(Date.now() / 1000) - 600 }))
    expect(res.status).toBe(401)
  })

  it('rejects a body that is not JSON, and one that is too large', async () => {
    expect((await POST(request(null, { raw: 'not json' }))).status).toBe(400)
    expect((await POST(request(null, { raw: ' '.repeat(300 * 1024) }))).status).toBe(413)
  })
})

describe('POST /api/vircle-chat/webhook: what it does', () => {
  it('stores an inbound message, answers with its id, and defers the fan-out until after the answer', async () => {
    const res = await POST(request(inboundBody))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, message_id: 'msg-1' })
    expect(h.ingest).toHaveBeenCalledTimes(1)
    expect(h.fanOut).not.toHaveBeenCalled()
    await h.afterCallbacks[0]()
    expect(h.fanOut).toHaveBeenCalled()
    expect(h.eventsUpserts[0]).toEqual({ account_id: 'acct-1', event_id: 'evt_1' })
    expect(h.configUpdates.some((u) => 'last_inbound_at' in u)).toBe(true)
  })

  it('applies a receipt', async () => {
    const res = await POST(request({ event: 'message.receipt', event_id: 'evt_2', workspace_key: 'vcw_abcdefghijklmnop1234', server_id: 'm_9', status: 'read' }))
    expect(await res.json()).toEqual({ ok: true, receipt: 'updated' })
    expect(h.receipt).toHaveBeenCalledTimes(1)
  })

  it('does nothing twice for an event id it has handled', async () => {
    h.seen = true
    const res = await POST(request(inboundBody))
    expect(await res.json()).toEqual({ ok: true, duplicate: true })
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('answers 200 "paused" for a paused connection or a workspace the operator switched off, so the gateway stops retrying', async () => {
    h.row = { ...h.row!, enabled: false }
    expect(await (await POST(request(inboundBody))).json()).toEqual({ ok: true, ignored: 'paused' })
    h.row = { ...h.row!, enabled: true }
    h.enabled = false
    expect(await (await POST(request(inboundBody))).json()).toEqual({ ok: true, ignored: 'paused' })
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('rejects an invalid payload with a reason the gateway team can read', async () => {
    const res = await POST(request({ ...inboundBody, user: { name: 'no wallet' } }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_payload', detail: 'user.wallet_id is required' })
  })

  it('ignores event types it does not know', async () => {
    const res = await POST(request({ event: 'user.presence', event_id: 'e', workspace_key: 'vcw_abcdefghijklmnop1234' }))
    expect(await res.json()).toEqual({ ok: true, ignored: 'user.presence' })
  })

  it('answers 429 with Retry-After when a workspace floods it', async () => {
    h.limited = true
    const res = await POST(request(inboundBody))
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('answers 5xx and records the error, without remembering the event, so the gateway retries', async () => {
    h.ingest.mockRejectedValueOnce(new Error('database down'))
    const res = await POST(request(inboundBody))
    expect(res.status).toBe(500)
    expect(h.eventsUpserts).toHaveLength(0)
    expect(h.configUpdates).toContainEqual({ last_error: 'database down' })
  })
})
