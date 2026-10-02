import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  updates: [] as { table: string; patch: Record<string, unknown>; id: string }[],
  resume: vi.fn(),
}))

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: h.rpc,
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => ({
        eq: async (_col: string, id: string) => {
          h.updates.push({ table, patch, id })
          return { error: null }
        },
      }),
    }),
  }),
}))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ rpc: vi.fn(async () => ({ data: null, error: null })) }) }))
vi.mock('@/lib/automations/engine', () => ({ resumePendingExecution: h.resume }))

import { GET } from './route'

const call = () =>
  GET(new Request('http://localhost/api/automations/cron', { headers: { 'x-cron-secret': 's3cret' } }))

const row = (id: string, account = 'acc-1') => ({
  id,
  automation_id: 'auto-1',
  account_id: account,
  user_id: 'u1',
  contact_id: null,
  log_id: null,
  parent_step_id: null,
  branch: null,
  next_step_position: 1,
  context: {},
})

beforeEach(() => {
  h.rpc.mockReset()
  h.resume.mockReset()
  h.updates = []
  process.env.AUTOMATION_CRON_SECRET = 's3cret'
})

describe('GET /api/automations/cron', () => {
  it('claims through the fair, leased database function and resumes each row', async () => {
    h.rpc.mockResolvedValue({ data: [row('r1'), row('r2', 'acc-2')], error: null })
    const res = await call()
    expect(await res.json()).toEqual({ processed: 2, failed: 0, released: 0 })
    expect(h.rpc).toHaveBeenCalledWith('automation_claim_pending', { p_limit: 50, p_per_account: 10, p_lease_seconds: 600 })
    expect(h.resume).toHaveBeenCalledTimes(2)
    expect(h.resume.mock.calls[1][0]).toMatchObject({ id: 'r2', account_id: 'acc-2' })
  })

  it('reports nothing to do without touching the engine', async () => {
    h.rpc.mockResolvedValue({ data: [], error: null })
    expect(await (await call()).json()).toEqual({ processed: 0 })
    expect(h.resume).not.toHaveBeenCalled()
  })

  it('fails one bad row, keeps going, and does not leave it running', async () => {
    h.rpc.mockResolvedValue({ data: [row('bad'), row('good')], error: null })
    h.resume.mockImplementationOnce(async () => {
      throw new Error('step exploded')
    })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await call()
      expect(await res.json()).toEqual({ processed: 1, failed: 1, released: 0 })
    } finally {
      err.mockRestore()
    }
    expect(h.resume).toHaveBeenCalledTimes(2)
    expect(h.updates).toEqual([{ table: 'automation_pending_executions', patch: { status: 'failed' }, id: 'bad' }])
  })

  it('surfaces a database error as a 500', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: 'rpc missing' } })
    const res = await call()
    expect(res.status).toBe(500)
  })

  it('refuses without the shared secret', async () => {
    const res = await GET(new Request('http://localhost/api/automations/cron'))
    expect(res.status).toBe(401)
    expect(h.rpc).not.toHaveBeenCalled()
  })
})
