import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  handleTranslate: vi.fn(),
  checkRateLimit: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: () => Response.json({ error: 'auth failed' }, { status: 403 }),
}))
vi.mock('@/lib/knowledge/translate-run', () => ({ handleTranslate: h.handleTranslate }))
vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: () => ({ name: 'admin-client' }) }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: h.checkRateLimit,
  rateLimitResponse: () => Response.json({ error: 'slow down' }, { status: 429 }),
  RATE_LIMITS: { aiDraft: { limit: 20, windowMs: 60_000 }, aiDraftAccount: { limit: 60, windowMs: 60_000 } },
}))

import { POST } from './route'

const ctx = (role: string) => ({ supabase: { name: 'scoped' }, accountId: 'acct', userId: 'user-1', role })
const params = { params: Promise.resolve({ id: 'base-1' }) }
const req = (body: unknown) =>
  new Request('http://localhost/api/knowledge/base-1/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

beforeEach(() => {
  h.requireRole.mockReset()
  h.handleTranslate.mockReset()
  h.checkRateLimit.mockReset()
  h.checkRateLimit.mockReturnValue({ success: true, remaining: 5, reset: 0, limit: 20 })
  h.requireRole.mockResolvedValue(ctx('agent'))
  h.handleTranslate.mockResolvedValue({ status: 200, body: { results: [{ language: 'ms', ok: true, id: 'ms1' }] } })
})

describe('POST /api/knowledge/[id]/translate', () => {
  it('needs an agent and hands the request to the translate logic', async () => {
    const res = await POST(req({ language: 'ms' }), params)
    expect(h.requireRole).toHaveBeenCalledWith('agent')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ results: [{ language: 'ms', ok: true, id: 'ms1' }] })
    expect(h.handleTranslate).toHaveBeenCalledWith(
      { db: { name: 'scoped' }, admin: { name: 'admin-client' }, accountId: 'acct', userId: 'user-1', isAdmin: false },
      'base-1',
      { language: 'ms' },
    )
  })

  it('tells the logic when the caller is an admin or the owner', async () => {
    for (const role of ['admin', 'owner']) {
      h.handleTranslate.mockClear()
      h.requireRole.mockResolvedValue(ctx(role))
      await POST(req({ language: 'ms' }), params)
      expect(h.handleTranslate.mock.calls[0][0].isAdmin).toBe(true)
    }
  })

  it('passes the logic status and typed error straight through', async () => {
    h.handleTranslate.mockResolvedValue({
      status: 429,
      body: { results: [{ language: 'ms', ok: false, code: 'budget_exceeded' }], error: 'used up', code: 'budget_exceeded' },
    })
    const res = await POST(req({ language: 'ms' }), params)
    expect(res.status).toBe(429)
    expect((await res.json()).code).toBe('budget_exceeded')
  })

  it('is rate-limited per person and per account, before anything is translated', async () => {
    h.checkRateLimit.mockReturnValueOnce({ success: false, remaining: 0, reset: 0, limit: 20 })
    expect((await POST(req({ language: 'ms' }), params)).status).toBe(429)
    h.checkRateLimit.mockReturnValueOnce({ success: true }).mockReturnValueOnce({ success: false })
    expect((await POST(req({ language: 'ms' }), params)).status).toBe(429)
    expect(h.handleTranslate).not.toHaveBeenCalled()
    expect(h.checkRateLimit.mock.calls.map((c) => c[0])).toEqual(['kb-translate:user-1', 'kb-translate:user-1', 'kb-translate-acct:acct'])
  })

  it('answers with the auth error when the caller is not allowed', async () => {
    h.requireRole.mockRejectedValue(new Error('Forbidden'))
    expect((await POST(req({ language: 'ms' }), params)).status).toBe(403)
    expect(h.handleTranslate).not.toHaveBeenCalled()
  })

  it('treats an unreadable body as an empty request', async () => {
    await POST(req('not json'), params)
    expect(h.handleTranslate.mock.calls[0][2]).toBeNull()
  })
})
