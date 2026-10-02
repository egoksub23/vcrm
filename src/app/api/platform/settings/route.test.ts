import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ requirePlatformAdmin: vi.fn(), rpc: vi.fn() }))

vi.mock('@/lib/platform/auth', () => ({ requirePlatformAdmin: h.requirePlatformAdmin }))
vi.mock('@/lib/auth/account', () => ({
  toErrorResponse: (err: unknown) =>
    Response.json({ error: (err as Error).message }, { status: (err as { status?: number }).status ?? 500 }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { adminAction: {} },
}))

import { GET, PATCH } from './route'

const patch = (body: unknown) =>
  PATCH(
    new Request('http://localhost/api/platform/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

beforeEach(() => {
  h.requirePlatformAdmin.mockReset()
  h.rpc.mockReset()
  h.requirePlatformAdmin.mockResolvedValue({ supabase: { rpc: h.rpc }, userId: 'op-1' })
  h.rpc.mockResolvedValue({ data: null, error: null })
})

describe('/api/platform/settings', () => {
  it('reports whether sign-up is open', async () => {
    h.rpc.mockResolvedValue({ data: true, error: null })
    const res = await GET()
    expect(await res.json()).toEqual({ open_signup: true })
    expect(h.rpc).toHaveBeenCalledWith('signup_is_open')
  })

  it('switches sign-up off and on through platform_set_open_signup', async () => {
    expect((await patch({ open_signup: false })).status).toBe(200)
    expect(h.rpc).toHaveBeenLastCalledWith('platform_set_open_signup', { p_open: false })
    expect((await patch({ open_signup: true })).status).toBe(200)
    expect(h.rpc).toHaveBeenLastCalledWith('platform_set_open_signup', { p_open: true })
  })

  it('rejects a body that is not a boolean without calling the database', async () => {
    expect((await patch({ open_signup: 'yes' })).status).toBe(400)
    expect((await patch({})).status).toBe(400)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('maps a database refusal (not an operator) to 403', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'nope' } })
    expect((await patch({ open_signup: true })).status).toBe(403)
  })

  it('refuses a caller who is not a platform admin', async () => {
    h.requirePlatformAdmin.mockRejectedValue(Object.assign(new Error('Platform administrator access required'), { status: 403 }))
    expect((await GET()).status).toBe(403)
    expect((await patch({ open_signup: true })).status).toBe(403)
    expect(h.rpc).not.toHaveBeenCalled()
  })
})
