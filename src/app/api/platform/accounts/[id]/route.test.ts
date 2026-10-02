import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  rpc: vi.fn(),
}))

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

import { PATCH } from './route'

const ID = '11111111-1111-4111-8111-111111111111'

const patch = (body: unknown, id = ID) =>
  PATCH(
    new Request(`http://localhost/api/platform/accounts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )

beforeEach(() => {
  h.requirePlatformAdmin.mockReset()
  h.rpc.mockReset()
  h.requirePlatformAdmin.mockResolvedValue({ supabase: { rpc: h.rpc }, userId: 'op-1' })
  h.rpc.mockResolvedValue({ data: null, error: null })
})

describe('PATCH /api/platform/accounts/[id]', () => {
  it('updates plan, limits and features through platform_update_account', async () => {
    const res = await patch({ plan: 'pro', limits: { seats: 10 }, features: { incidents: false } })
    expect(res.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledWith('platform_update_account', {
      p_account: ID,
      p_plan: 'pro',
      p_limits: { seats: 10 },
      p_features: { incidents: false },
    })
  })

  it('suspends through platform_set_account_status with the reason', async () => {
    const res = await patch({ status: 'suspended', reason: 'unpaid' })
    expect(res.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledTimes(1)
    expect(h.rpc).toHaveBeenCalledWith('platform_set_account_status', {
      p_account: ID,
      p_status: 'suspended',
      p_reason: 'unpaid',
    })
  })

  it('can change settings and status in one request', async () => {
    await patch({ plan: 'pro', status: 'active' })
    expect(h.rpc.mock.calls.map((c) => c[0])).toEqual(['platform_update_account', 'platform_set_account_status'])
  })

  it('re-seeds the defaults through platform_reseed_account', async () => {
    const res = await patch({ reseed: true })
    expect(res.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledWith('platform_reseed_account', { p_account: ID })
  })

  it('rejects an unknown feature or limit key without calling the database', async () => {
    expect((await patch({ features: { teleport: true } })).status).toBe(400)
    expect((await patch({ limits: { widgets: 5 } })).status).toBe(400)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('rejects a malformed workspace id', async () => {
    const res = await patch({ plan: 'pro' }, 'not-a-uuid')
    expect(res.status).toBe(400)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('maps the RPC validation error (22023) to 400 and not-an-operator (42501) to 403', async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'You cannot suspend your own workspace' } })
    const own = await patch({ status: 'suspended' })
    expect(own.status).toBe(400)
    expect((await own.json()).error).toMatch(/own workspace/)

    h.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'Platform administrator access required' } })
    expect((await patch({ status: 'suspended' })).status).toBe(403)
  })

  it('does not leak an unexpected database error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      h.rpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'secret internals' } })
      const res = await patch({ plan: 'pro' })
      expect(res.status).toBe(500)
      expect(JSON.stringify(await res.json())).not.toMatch(/secret internals/)
    } finally {
      err.mockRestore()
    }
  })

  it('refuses a caller who is not a platform admin', async () => {
    h.requirePlatformAdmin.mockRejectedValue(Object.assign(new Error('Platform administrator access required'), { status: 403 }))
    const res = await patch({ plan: 'pro' })
    expect(res.status).toBe(403)
    expect(h.rpc).not.toHaveBeenCalled()
  })
})
