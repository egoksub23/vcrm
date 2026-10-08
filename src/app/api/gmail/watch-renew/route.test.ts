import { beforeEach, describe, expect, it, vi } from 'vitest'

// The watch renewal job keeps every Gmail mailbox's push watch alive. A mailbox that is not used for the customer care inbox (inbox_enabled false,
// migration 179) has no watch on purpose: the job leaves it out of the query, would leave it out of the list even if the query returned it, and neither
// renews it (which would quietly start the push again), nor counts it as failed, nor logs a problem for it.

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  filters: [] as { fn: string; args: unknown[] }[],
  watch: vi.fn(),
  updates: [] as { table: string; patch: Record<string, unknown> }[],
  rpc: vi.fn(async () => ({ error: null })),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      const rec = (fn: string) => (...args: unknown[]) => (h.filters.push({ fn, args }), chain)
      for (const fn of ['select', 'eq', 'neq', 'or', 'order', 'limit']) chain[fn] = rec(fn)
      chain.update = (patch: Record<string, unknown>) => ({ eq: async () => (h.updates.push({ table, patch }), { error: null }) })
      chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: h.rows, error: null })
      return chain
    },
  }),
}))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ rpc: h.rpc }) }))
vi.mock('@/lib/platform/active', () => ({ suspendedAccountIds: async () => new Set<string>() }))
vi.mock('@/lib/gmail/token', () => ({ getValidAccessToken: async () => 'tok' }))
vi.mock('@/lib/gmail/gmail-api', () => ({ watchMailbox: (...a: unknown[]) => h.watch(...a) }))

import { GET } from './route'

const call = () => GET(new Request('https://halo.test/api/gmail/watch-renew', { headers: { 'x-cron-secret': 'sekret' } }))

beforeEach(() => {
  process.env.AUTOMATION_CRON_SECRET = 'sekret'
  process.env.GMAIL_PUBSUB_TOPIC = 'projects/p/topics/t'
  h.rows = []
  h.filters = []
  h.updates = []
  h.watch.mockReset().mockResolvedValue({ historyId: '900', expiration: '2026-10-15T00:00:00Z' })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('the Gmail watch renewal job', () => {
  it('asks only for connected mailboxes that are used for the customer care inbox', async () => {
    await call()
    expect(h.filters).toContainEqual({ fn: 'eq', args: ['status', 'connected'] })
    expect(h.filters).toContainEqual({ fn: 'neq', args: ['inbox_enabled', false] })
  })

  it('renews a mailbox it is given and records the new expiry, keeping the history baseline it already has', async () => {
    h.rows = [{ id: 'g1', account_id: 'A', inbox_enabled: true, history_id: '100' }]
    expect(await (await call()).json()).toMatchObject({ renewed: 1, failed: 0 })
    expect(h.updates).toEqual([{ table: 'gmail_config', patch: { watch_expiration: '2026-10-15T00:00:00Z' } }])
  })

  it('leaves a mailbox whose inbox is off alone even if the query returned it: no watch registered, not counted, nothing logged', async () => {
    h.rows = [{ id: 'off', account_id: 'OFF', inbox_enabled: false, watch_expiration: null }]
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ renewed: 0 })
    expect(h.watch).not.toHaveBeenCalled()
    expect(h.updates).toEqual([])
    expect(console.error).not.toHaveBeenCalled()
    const heartbeat = h.rpc.mock.calls.at(-1) as unknown as [string, { p_status: string }]
    expect(heartbeat[1].p_status).toBe('ok')
  })

  it('renews the others around it', async () => {
    h.rows = [
      { id: 'off', account_id: 'OFF', inbox_enabled: false },
      { id: 'on', account_id: 'ON', inbox_enabled: true },
    ]
    expect(await (await call()).json()).toMatchObject({ renewed: 1, failed: 0 })
    expect(h.watch).toHaveBeenCalledTimes(1)
  })

  it('still counts a real failure for a mailbox that is meant to have a watch', async () => {
    h.rows = [{ id: 'on', account_id: 'ON', inbox_enabled: true }]
    h.watch.mockRejectedValue(new Error('Google down'))
    expect(await (await call()).json()).toMatchObject({ renewed: 0, failed: 1 })
  })
})
