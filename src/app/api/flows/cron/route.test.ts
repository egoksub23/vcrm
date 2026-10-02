import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  suspended: [] as string[],
  pages: [] as unknown[][],
  orFilters: [] as string[],
  timedOut: [] as string[],
  events: [] as unknown[],
  rpc: vi.fn(async () => ({ data: null, error: null })),
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: h.rpc,
    from: (table: string) => {
      if (table === 'account_platform') {
        return {
          select: () => ({
            eq: async () => ({ data: h.suspended.map((account_id) => ({ account_id })), error: null }),
          }),
        }
      }
      if (table === 'flow_run_events') {
        return { insert: async (row: unknown) => (h.events.push(row), { error: null }) }
      }
      // flow_runs: a read chain (select/eq/order/order/limit/[or]) that resolves to the next page,
      // and an update chain (update/eq/eq/select) that records the swept run.
      const read: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'order', 'limit']) read[m] = () => read
      read.or = (f: string) => (h.orFilters.push(f), read)
      read.then = (resolve: (v: unknown) => unknown) => resolve({ data: h.pages.shift() ?? [], error: null })
      return {
        ...read,
        update: () => {
          let id = ''
          const chain: Record<string, unknown> = {}
          chain.eq = (col: string, v: string) => {
            if (col === 'id') id = v
            return chain
          }
          chain.select = async () => (h.timedOut.push(id), { data: [{ id }], error: null })
          return chain
        },
      }
    },
  }),
}))

import { GET } from './route'

const call = () => GET(new Request('http://localhost/api/flows/cron', { headers: { 'x-cron-secret': 's3cret' } }))

const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString()
const run = (id: string, account: string, ageHours: number, policy: unknown = null) => ({
  id,
  flow_id: 'f1',
  account_id: account,
  user_id: 'u',
  contact_id: 'c',
  last_advanced_at: hoursAgo(ageHours),
  flows: { fallback_policy: policy },
})

beforeEach(() => {
  h.suspended = []
  h.pages = []
  h.orFilters = []
  h.timedOut = []
  h.events = []
  process.env.AUTOMATION_CRON_SECRET = 's3cret'
})

describe('GET /api/flows/cron', () => {
  it('times out runs older than their policy and leaves younger ones alone', async () => {
    h.pages = [[run('old', 'a1', 30), run('young', 'a1', 2), run('short', 'a1', 3, { on_timeout_hours: 1 })]]
    const body = await (await call()).json()
    expect(h.timedOut.sort()).toEqual(['old', 'short'])
    expect(body).toMatchObject({ swept: 2, scanned: 3, truncated: false })
  })

  it('does not touch a suspended workspace\'s runs', async () => {
    h.suspended = ['a-susp']
    h.pages = [[run('stale-suspended', 'a-susp', 99), run('stale-active', 'a-ok', 99)]]
    await call()
    expect(h.timedOut).toEqual(['stale-active'])
  })

  it('keeps reading until a short page, continuing after the last row it saw (keyset, not offset)', async () => {
    const full = Array.from({ length: 500 }, (_, i) => run(`r${i}`, 'a1', 1))
    h.pages = [full, [run('tail', 'a1', 1)]]
    const body = await (await call()).json()
    expect(body).toMatchObject({ scanned: 501 })
    expect(h.orFilters).toHaveLength(1)
    expect(h.orFilters[0]).toContain('id.gt.r499')
  })

  it('refuses without the shared secret', async () => {
    const res = await GET(new Request('http://localhost/api/flows/cron'))
    expect(res.status).toBe(401)
  })
})
