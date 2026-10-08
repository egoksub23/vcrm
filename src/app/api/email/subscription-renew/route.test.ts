import { beforeEach, describe, expect, it, vi } from 'vitest'

// The renewal job keeps every Microsoft 365 mailbox's change-notification subscription alive. A mailbox that is not used for the customer care inbox
// (inbox_enabled false, migration 179) has no subscription on purpose: the job leaves it out of the query, would leave it out of the list even if the
// query returned it, and neither renews it, nor counts it as failed, nor logs a problem for it.

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  filters: [] as { fn: string; args: unknown[] }[],
  renew: vi.fn(),
  rpc: vi.fn(async () => ({ error: null })),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => {
    const chain: Record<string, unknown> = {}
    const rec = (fn: string) => (...args: unknown[]) => (h.filters.push({ fn, args }), chain)
    for (const fn of ['select', 'eq', 'neq', 'or', 'order', 'limit']) chain[fn] = rec(fn)
    chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: h.rows, error: null })
    return { from: () => chain }
  },
}))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ rpc: h.rpc }) }))
vi.mock('@/lib/platform/active', () => ({ suspendedAccountIds: async () => new Set<string>(['suspended']) }))
vi.mock('@/lib/ms365/oauth', () => ({ getOAuthBaseUrl: () => 'https://halo.test' }))
vi.mock('@/lib/ms365/subscription-renewal', () => ({ renewMailboxSubscription: (...a: unknown[]) => h.renew(...a) }))

import { GET } from './route'

const call = () => GET(new Request('https://halo.test/api/email/subscription-renew', { headers: { 'x-cron-secret': 'sekret' } }))

beforeEach(() => {
  process.env.AUTOMATION_CRON_SECRET = 'sekret'
  h.rows = []
  h.filters = []
  h.renew.mockReset().mockResolvedValue({ subscriptionId: 's', expiresAt: 'x', recreated: false })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('the Microsoft 365 subscription renewal job', () => {
  it('asks only for connected mailboxes that are used for the customer care inbox', async () => {
    await call()
    expect(h.filters).toContainEqual({ fn: 'eq', args: ['status', 'connected'] })
    expect(h.filters).toContainEqual({ fn: 'neq', args: ['inbox_enabled', false] })
  })

  it('renews the mailboxes it is given, and not a suspended workspace\'s', async () => {
    h.rows = [
      { id: 'a', account_id: 'A', inbox_enabled: true },
      { id: 'b', account_id: 'suspended', inbox_enabled: true },
      { id: 'c', account_id: 'C' },
    ]
    const body = await (await call()).json()
    expect(body).toMatchObject({ renewed: 2, failed: 0 })
    expect(h.renew).toHaveBeenCalledTimes(2)
  })

  it('leaves a mailbox whose inbox is off alone even if the query returned it: not renewed, not failed, nothing logged', async () => {
    h.rows = [
      { id: 'off', account_id: 'OFF', inbox_enabled: false, subscription_id: null, subscription_expires_at: null },
      { id: 'on', account_id: 'ON', inbox_enabled: true },
    ]
    const res = await call()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ renewed: 1, failed: 0 })
    expect(h.renew).toHaveBeenCalledTimes(1)
    expect((h.renew.mock.calls[0][0] as { config: { id: string } }).config.id).toBe('on')
    expect(console.error).not.toHaveBeenCalled()
  })

  it('reports an empty run, without a failure, when the only mailbox has its inbox off', async () => {
    h.rows = [{ id: 'off', account_id: 'OFF', inbox_enabled: false }]
    const res = await call()
    expect(await res.json()).toEqual({ renewed: 0 })
    expect(h.renew).not.toHaveBeenCalled()
    // the run is recorded as ok, so the console does not call the job failed
    const heartbeat = h.rpc.mock.calls.at(-1) as unknown as [string, { p_status: string }]
    expect(heartbeat[1].p_status).toBe('ok')
  })

  it('still counts a real failure for a mailbox that is meant to have a subscription', async () => {
    h.rows = [{ id: 'on', account_id: 'ON', inbox_enabled: true }]
    h.renew.mockRejectedValue(new Error('Graph down'))
    expect(await (await call()).json()).toMatchObject({ renewed: 0, failed: 1 })
  })
})
