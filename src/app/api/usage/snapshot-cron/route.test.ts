import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rpc: vi.fn(), measure: vi.fn() }))

vi.mock('@/lib/postgres/db', () => ({ createAdminPgDb: () => ({ rpc: h.rpc }) }))
vi.mock('@/lib/storage/usage-measure', () => ({ measureAccountStorage: h.measure }))

import { GET } from './route'

const call = () =>
  GET(new Request('http://localhost/api/usage/snapshot-cron', { headers: { 'x-cron-secret': 'test-secret' } }))

/** The arguments the daily job was called with (the heartbeat also uses rpc). */
const jobArgs = () => h.rpc.mock.calls.find((c) => c[0] === 'usage_snapshot_run')?.[1]

beforeEach(() => {
  process.env.AUTOMATION_CRON_SECRET = 'test-secret'
  h.rpc.mockReset()
  h.measure.mockReset()
  h.rpc.mockResolvedValue({ data: 2, error: null })
})

describe('GET /api/usage/snapshot-cron', () => {
  it('measures stored files in the app and hands them to the database job', async () => {
    h.measure.mockResolvedValue({ 'aaaaaaaa-0000-0000-0000-000000000001': 4096 })
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ measured: 2, storage: 'measured' })
    expect(jobArgs()).toEqual({ p_limit: 200, p_storage: { 'aaaaaaaa-0000-0000-0000-000000000001': 4096 } })
  })

  it('still runs the job when the files cannot be measured, so the other counters are written', async () => {
    h.measure.mockRejectedValue(new Error('ENOENT: no such file or directory'))
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ measured: 2, storage: 'carried-forward' })
    expect(jobArgs()).toEqual({ p_limit: 200, p_storage: null })
  })

  it('reports a database failure as an error', async () => {
    h.measure.mockResolvedValue({})
    h.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } })
    const res = await call()
    expect(res.status).toBe(500)
  })

  it('refuses a caller without the cron secret', async () => {
    const res = await GET(new Request('http://localhost/api/usage/snapshot-cron'))
    expect(res.status).toBe(401)
    expect(h.measure).not.toHaveBeenCalled()
  })
})
