import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ requirePlatformAdmin: vi.fn(), rpc: vi.fn() }))

vi.mock('@/lib/platform/auth', () => ({ requirePlatformAdmin: h.requirePlatformAdmin }))
vi.mock('@/lib/auth/account', () => ({
  toErrorResponse: (err: unknown) =>
    Response.json({ error: (err as Error).message }, { status: (err as { status?: number }).status ?? 500 }),
}))

import { GET } from './route'
import { CRON_INTERVALS } from '@/lib/cron/guard'

beforeEach(() => {
  h.requirePlatformAdmin.mockReset()
  h.rpc.mockReset()
  h.requirePlatformAdmin.mockResolvedValue({ supabase: { rpc: h.rpc }, userId: 'op-1' })
})

describe('GET /api/platform/cron', () => {
  it('lists every expected job, marking one that never reported as late', async () => {
    h.rpc.mockResolvedValue({
      data: [
        {
          job: 'automations',
          expected_seconds: 300,
          last_run_at: '2026-10-02T10:00:00Z',
          last_ok_at: '2026-10-02T10:00:00Z',
          last_status: 'ok',
          last_duration_ms: 120,
          last_result: { processed: 2 },
          late: false,
        },
      ],
      error: null,
    })
    const body = await (await GET()).json()
    expect(body.jobs.map((j: { job: string }) => j.job).sort()).toEqual(Object.keys(CRON_INTERVALS).sort())
    const auto = body.jobs.find((j: { job: string }) => j.job === 'automations')
    expect(auto).toMatchObject({ late: false, last_status: 'ok', last_result: { processed: 2 } })
    const never = body.jobs.find((j: { job: string }) => j.job === 'flows')
    expect(never).toMatchObject({ late: true, last_run_at: null, last_status: null })
    expect(h.rpc).toHaveBeenCalledWith('platform_cron_status')
  })

  it('uses the interval this build expects, not a stale stored one', async () => {
    h.rpc.mockResolvedValue({
      data: [{ job: 'jira', expected_seconds: 9999, last_run_at: 'x', last_ok_at: 'x', last_status: 'ok', last_duration_ms: 1, last_result: null, late: false }],
      error: null,
    })
    const body = await (await GET()).json()
    expect(body.jobs.find((j: { job: string }) => j.job === 'jira').expected_seconds).toBe(CRON_INTERVALS.jira)
  })

  it('refuses a caller who is not a platform admin', async () => {
    h.requirePlatformAdmin.mockRejectedValue(Object.assign(new Error('Platform administrator access required'), { status: 403 }))
    expect((await GET()).status).toBe(403)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('does not leak a database error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      h.rpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'secret internals' } })
      const res = await GET()
      expect(res.status).toBe(500)
      expect(JSON.stringify(await res.json())).not.toMatch(/secret internals/)
    } finally {
      err.mockRestore()
    }
  })
})
