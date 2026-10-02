import { beforeEach, describe, expect, it, vi } from 'vitest'

const shared = vi.fn()
vi.mock('@/lib/rate-limit-shared', () => ({ checkSharedRateLimit: (...a: unknown[]) => shared(...a) }))

import { parsePlatformRow } from '@/lib/platform/features'
import { enforceBroadcastRecipientCap } from './recipient-cap'

beforeEach(() => shared.mockReset())

describe('enforceBroadcastRecipientCap', () => {
  it('does nothing when the operator set no cap', async () => {
    expect(await enforceBroadcastRecipientCap('a1', parsePlatformRow({}), 500)).toBeNull()
    expect(await enforceBroadcastRecipientCap('a1', undefined, 500)).toBeNull()
    expect(shared).not.toHaveBeenCalled()
  })

  it('charges the recipient count against a rolling day, per workspace', async () => {
    shared.mockResolvedValue({ success: true, remaining: 90, reset: Date.now() + 1000, limit: 100 })
    const platform = parsePlatformRow({ limits: { broadcast_per_day: 100 } })
    expect(await enforceBroadcastRecipientCap('a1', platform, 10)).toBeNull()
    expect(shared).toHaveBeenCalledWith('broadcast-recipients:a1', { limit: 100, windowMs: 86_400_000 }, 10)
  })

  it('answers 429 with a stable code when the batch does not fit', async () => {
    shared.mockResolvedValue({ success: false, remaining: 4, reset: Date.now() + 5000, limit: 100 })
    const res = await enforceBroadcastRecipientCap('a1', parsePlatformRow({ limits: { broadcast_per_day: 100 } }), 10)
    expect(res?.status).toBe(429)
    const body = await res!.json()
    expect(body.code).toBe('broadcast_daily_limit')
    expect(body.remaining).toBe(4)
    expect(res!.headers.get('Retry-After')).toBeTruthy()
  })

  it('a cap of zero blocks broadcasts without touching the counter', async () => {
    const res = await enforceBroadcastRecipientCap('a1', parsePlatformRow({ limits: { broadcast_per_day: 0 } }), 1)
    expect(res?.status).toBe(429)
    expect(shared).not.toHaveBeenCalled()
  })
})
