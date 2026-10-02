import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ rpc: h.rpc }) }))

import { checkCronSecret, cronRoute, forEachWithinBudget } from './guard'

const req = (secret?: string) =>
  new Request('http://localhost/api/x/cron', { headers: secret === undefined ? {} : { 'x-cron-secret': secret } })

beforeEach(() => {
  h.rpc.mockReset()
  h.rpc.mockResolvedValue({ data: null, error: null })
  process.env.AUTOMATION_CRON_SECRET = 's3cret'
})

describe('checkCronSecret', () => {
  it('answers 503 when the secret is not configured', async () => {
    delete process.env.AUTOMATION_CRON_SECRET
    expect(checkCronSecret(req('x'))?.status).toBe(503)
  })

  it('answers 401 for a missing, wrong or different-length secret', () => {
    expect(checkCronSecret(req())?.status).toBe(401)
    expect(checkCronSecret(req('wrong!'))?.status).toBe(401)
    expect(checkCronSecret(req('s3cret-and-more'))?.status).toBe(401)
  })

  it('lets the right secret through', () => {
    expect(checkCronSecret(req('s3cret'))).toBeNull()
  })
})

describe('cronRoute', () => {
  it('refuses without the secret and runs nothing', async () => {
    const run = vi.fn()
    const res = await cronRoute('job', 300, run)(req('nope!!'))
    expect(res.status).toBe(401)
    expect(run).not.toHaveBeenCalled()
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('returns the body, and records an ok heartbeat with the expected interval', async () => {
    const res = await cronRoute('automations', 300, async () => ({ body: { processed: 3 } }))(req('s3cret'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ processed: 3 })
    expect(h.rpc).toHaveBeenCalledTimes(1)
    const [fn, args] = h.rpc.mock.calls[0]
    expect(fn).toBe('cron_heartbeat')
    expect(args).toMatchObject({ p_job: 'automations', p_expected_seconds: 300, p_status: 'ok', p_result: { processed: 3 } })
  })

  it('records an error heartbeat for a 5xx result and passes the status through', async () => {
    const res = await cronRoute('j', 60, async () => ({ status: 500, body: { error: 'db down' } }))(req('s3cret'))
    expect(res.status).toBe(500)
    expect(h.rpc.mock.calls[0][1]).toMatchObject({ p_status: 'error' })
  })

  it('turns a thrown error into a generic 500 (no internals) and an error heartbeat', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await cronRoute('j', 60, async () => {
        throw new Error('secret internals')
      })(req('s3cret'))
      expect(res.status).toBe(500)
      expect(JSON.stringify(await res.json())).not.toMatch(/secret internals/)
      expect(h.rpc.mock.calls[0][1]).toMatchObject({ p_status: 'error' })
    } finally {
      err.mockRestore()
    }
  })

  it('never fails the job because the heartbeat could not be written', async () => {
    h.rpc.mockRejectedValue(new Error('rpc down'))
    const res = await cronRoute('j', 60, async () => ({ body: { ok: true } }))(req('s3cret'))
    expect(res.status).toBe(200)
  })

  it('shortens long strings in the stored result', async () => {
    await cronRoute('j', 60, async () => ({ body: { note: 'x'.repeat(500) } }))(req('s3cret'))
    expect((h.rpc.mock.calls[0][1].p_result as { note: string }).note.length).toBe(200)
  })
})

describe('forEachWithinBudget', () => {
  it('works through everything when time allows', async () => {
    const seen: number[] = []
    const r = await forEachWithinBudget([1, 2, 3], 1000, async (n) => {
      seen.push(n)
    })
    expect(r).toEqual({ done: 3, skipped: [] })
    expect(seen).toEqual([1, 2, 3])
  })

  it('stops starting new items once the budget is spent and returns the rest', async () => {
    let t = 0
    const r = await forEachWithinBudget(
      ['a', 'b', 'c', 'd'],
      100,
      async () => {
        t += 60
      },
      () => t,
    )
    expect(r.done).toBe(2)
    expect(r.skipped).toEqual(['c', 'd'])
  })
})
