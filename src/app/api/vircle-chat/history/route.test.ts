import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  enabled: true,
  limited: false,
  badLimited: false,
  badCount: vi.fn(),
  page: vi.fn(),
  file: vi.fn(),
}))

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({}) }))
vi.mock('@/lib/net/client-ip', () => ({ clientIp: () => '203.0.113.9' }))
vi.mock('@/lib/rate-limit', () => ({
  isRateLimited: () => h.badLimited,
  checkRateLimit: (...a: unknown[]) => h.badCount(...a),
  RATE_LIMITS: { webhookInvalid: { limit: 1, windowMs: 1 }, vircleHistory: { limit: 1, windowMs: 1 } },
}))
vi.mock('@/lib/rate-limit-shared', () => ({
  checkSharedRateLimit: async () => ({ success: !h.limited, remaining: 0, reset: Date.now() + 5000, limit: 1 }),
}))
vi.mock('@/lib/vircle-chat/config', () => ({
  findConfigByKey: async () => h.row,
  openConfig: () => ({ signingSecret: 'vcs_secret', apiToken: 'tok' }),
}))
vi.mock('@/lib/vircle-chat/feature', () => ({ vircleChatEnabled: async () => h.enabled }))
vi.mock('@/lib/vircle-chat/history', async (orig) => ({
  ...(await orig<typeof import('@/lib/vircle-chat/history')>()),
  answerHistoryPage: (...a: unknown[]) => h.page(...a),
  answerHistoryFile: (...a: unknown[]) => h.file(...a),
}))

import { signBody } from '@/lib/vircle-chat/signing'
import { POST } from './route'

const pageBody = {
  v: 1,
  workspace_key: 'vcw_abcdefghijklmnop1234',
  conversation_id: 'c_1',
  wallet_id: 'W123',
  before: { sent_at: '2026-10-01T00:00:00Z', server_id: 'm_first' },
  limit: 30,
}

function request(body: unknown, opts: { secret?: string; timestamp?: number; raw?: string } = {}) {
  const raw = opts.raw ?? JSON.stringify(body)
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1000)
  return new Request('https://halo.example.com/api/vircle-chat/history', {
    method: 'POST',
    body: raw,
    headers: { 'x-vircle-timestamp': String(ts), 'x-vircle-signature': signBody(opts.secret ?? 'vcs_secret', ts, raw) },
  })
}

beforeEach(() => {
  h.row = { id: 'vc-1', account_id: 'acct-1', enabled: true, history_days: 90, signing_secret: 'enc', api_token: 'enc' }
  h.enabled = true
  h.limited = false
  h.badLimited = false
  h.badCount.mockReset()
  h.page.mockReset()
  h.file.mockReset()
  h.page.mockResolvedValue({ messages: [{ server_id: 'm_1' }], more: true, end: null })
  h.file.mockResolvedValue({ media: { download_url: 'https://files.example.com/a.png?token=t', kind: 'image', mime_type: 'image/png' } })
})

describe('POST /api/vircle-chat/history: who may call', () => {
  it('turns away an address that keeps failing, before reading anything', async () => {
    h.badLimited = true
    expect((await POST(request(pageBody))).status).toBe(429)
    expect(h.page).not.toHaveBeenCalled()
  })

  it('rejects a wrong signature and counts it against the caller', async () => {
    const res = await POST(request(pageBody, { secret: 'someone-elses' }))
    expect(res.status).toBe(401)
    expect(h.badCount).toHaveBeenCalled()
    expect(h.page).not.toHaveBeenCalled()
  })

  it('rejects an unknown workspace exactly like a wrong signature, and a request outside the five-minute window', async () => {
    h.row = null
    const res = await POST(request(pageBody))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Invalid signature' })
    h.row = { id: 'vc-1', account_id: 'acct-1', enabled: true, signing_secret: 'enc', api_token: 'enc' }
    expect((await POST(request(pageBody, { timestamp: Math.floor(Date.now() / 1000) - 600 }))).status).toBe(401)
  })

  it('rejects a body that is not JSON, and one that is too large', async () => {
    expect((await POST(request(null, { raw: 'not json' }))).status).toBe(400)
    expect((await POST(request(null, { raw: ' '.repeat(20 * 1024) }))).status).toBe(413)
  })
})

describe('POST /api/vircle-chat/history: what it answers', () => {
  it('answers a page for the workspace that signed it, with the person, the cursor and the limit', async () => {
    const res = await POST(request(pageBody))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ messages: [{ server_id: 'm_1' }], more: true })
    const [, cfg, req] = h.page.mock.calls[0]!
    expect(cfg).toMatchObject({ account_id: 'acct-1', history_days: 90 })
    expect(req).toEqual({ kind: 'page', walletId: 'W123', beforeSentAt: '2026-10-01T00:00:00.000Z', beforeServerId: 'm_first', limit: 30, notBefore: null })
  })

  it('says why there is no more only when there is no more', async () => {
    h.page.mockResolvedValue({ messages: [], more: false, end: 'window' })
    expect(await (await POST(request(pageBody))).json()).toEqual({ messages: [], more: false, end: 'window' })
  })

  it('answers a request for a file with a fresh address, or 404 when there is none', async () => {
    const ask = { v: 1, workspace_key: pageBody.workspace_key, conversation_id: 'c_1', wallet_id: 'W123', file_for: 'm_old1' }
    const ok = await POST(request(ask))
    expect(ok.status).toBe(200)
    expect((await ok.json()).media.download_url).toContain('https://files.example.com/')
    expect(h.file.mock.calls[0]![2]).toEqual({ kind: 'file', walletId: 'W123', serverId: 'm_old1' })
    h.file.mockResolvedValue(null)
    expect((await POST(request(ask))).status).toBe(404)
  })

  it.each([
    ['no wallet id', { ...pageBody, wallet_id: undefined }],
    ['no cursor', { ...pageBody, before: undefined }],
    ['a time that is not one', { ...pageBody, before: { sent_at: 'yesterday' } }],
    ['an id with a comma in it', { ...pageBody, before: { sent_at: '2026-10-01T00:00:00Z', server_id: 'a,b' } }],
    ['a file id that is not an id', { ...pageBody, file_for: '../x' }],
    ['a version that is not 1', { ...pageBody, v: 2 }],
  ])('refuses %s with 400', async (_name, body) => {
    expect((await POST(request(body))).status).toBe(400)
    expect(h.page).not.toHaveBeenCalled()
    expect(h.file).not.toHaveBeenCalled()
  })

  it('shows an empty page for a paused or switched-off workspace, and reads nothing', async () => {
    h.enabled = false
    expect(await (await POST(request(pageBody))).json()).toEqual({ ok: true, ignored: 'paused' })
    h.enabled = true
    h.row = { id: 'vc-1', account_id: 'acct-1', enabled: false, signing_secret: 'enc', api_token: 'enc' }
    expect(await (await POST(request(pageBody))).json()).toEqual({ ok: true, ignored: 'paused' })
    expect(h.page).not.toHaveBeenCalled()
  })

  it('limits a workspace that asks too often, and answers 503 when the database fails', async () => {
    h.limited = true
    const slow = await POST(request(pageBody))
    expect(slow.status).toBe(429)
    expect(slow.headers.get('retry-after')).toBeTruthy()
    h.limited = false
    h.page.mockRejectedValue(new Error('db down'))
    const down = await POST(request(pageBody))
    expect(down.status).toBe(503)
    expect(down.headers.get('retry-after')).toBe('10')
  })
})
