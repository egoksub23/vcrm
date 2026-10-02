import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.fn()
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ rpc }) }))

import { __resetRateLimitForTests } from '@/lib/rate-limit'
import { checkSharedRateLimit } from '@/lib/rate-limit-shared'

const OPTS = { limit: 3, windowMs: 60_000 }

beforeEach(() => {
  rpc.mockReset()
  __resetRateLimitForTests()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('checkSharedRateLimit', () => {
  it('passes the key, limit, window in seconds and cost to the database', async () => {
    rpc.mockResolvedValue({ data: [{ allowed: true, remaining: 2, reset_at: '2030-01-01T00:00:00Z' }], error: null })
    const r = await checkSharedRateLimit('send:acct:1', OPTS, 4)
    expect(rpc).toHaveBeenCalledWith('rate_limit_hit', { p_key: 'send:acct:1', p_limit: 3, p_window_seconds: 60, p_cost: 4 })
    expect(r).toEqual({ success: true, remaining: 2, reset: new Date('2030-01-01T00:00:00Z').getTime(), limit: 3 })
  })

  it('reports a refusal from the database', async () => {
    rpc.mockResolvedValue({ data: [{ allowed: false, remaining: 0, reset_at: '2030-01-01T00:00:00Z' }], error: null })
    const r = await checkSharedRateLimit('k', OPTS)
    expect(r.success).toBe(false)
    expect(r.remaining).toBe(0)
  })

  it('falls back to the in-process limiter when the call errors, and still enforces the limit', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } })
    for (let i = 0; i < 3; i++) expect((await checkSharedRateLimit('fallback', OPTS)).success).toBe(true)
    expect((await checkSharedRateLimit('fallback', OPTS)).success).toBe(false)
  })

  it('falls back when the call throws', async () => {
    rpc.mockRejectedValue(new Error('network'))
    expect((await checkSharedRateLimit('thrown', OPTS)).success).toBe(true)
  })

  it('fails open for a weighted spend when the counter is unreachable', async () => {
    rpc.mockRejectedValue(new Error('network'))
    expect((await checkSharedRateLimit('weighted', OPTS, 50)).success).toBe(true)
  })
})
