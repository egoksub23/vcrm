import { beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetActiveCacheForTests, isAccountActive, suspendedAccountIds } from './active'

function adminWith(result: { data: unknown; error: unknown } | (() => never)) {
  const maybeSingle = vi.fn(async () => (typeof result === 'function' ? result() : result))
  const select = vi.fn(() => ({
    eq: () => ({
      maybeSingle,
      then: (resolve: (v: unknown) => unknown) => resolve(typeof result === 'function' ? result() : result),
    }),
  }))
  return { client: { from: vi.fn(() => ({ select })) } as never, maybeSingle }
}

beforeEach(() => __resetActiveCacheForTests())

describe('isAccountActive', () => {
  it('is false only for a suspended workspace', async () => {
    expect(await isAccountActive(adminWith({ data: { status: 'suspended' }, error: null }).client, 'a1')).toBe(false)
    expect(await isAccountActive(adminWith({ data: { status: 'active' }, error: null }).client, 'a2')).toBe(true)
  })

  it('treats a missing row as active', async () => {
    expect(await isAccountActive(adminWith({ data: null, error: null }).client, 'a3')).toBe(true)
  })

  it('fails open on a read error or an exception', async () => {
    expect(await isAccountActive(adminWith({ data: null, error: { code: '42P01' } }).client, 'a4')).toBe(true)
    expect(
      await isAccountActive(
        adminWith(() => {
          throw new Error('boom')
        }).client,
        'a5',
      ),
    ).toBe(true)
  })

  it('answers from the cache for 30 seconds, then asks again', async () => {
    const { client, maybeSingle } = adminWith({ data: { status: 'suspended' }, error: null })
    let t = 1_000
    expect(await isAccountActive(client, 'a6', () => t)).toBe(false)
    t += 29_000
    expect(await isAccountActive(client, 'a6', () => t)).toBe(false)
    expect(maybeSingle).toHaveBeenCalledTimes(1)
    t += 2_000
    await isAccountActive(client, 'a6', () => t)
    expect(maybeSingle).toHaveBeenCalledTimes(2)
  })
})

describe('suspendedAccountIds', () => {
  it('returns the suspended ids, and an empty set on any failure', async () => {
    const ok = adminWith({ data: [{ account_id: 'x' }, { account_id: 'y' }], error: null })
    expect([...(await suspendedAccountIds(ok.client))].sort()).toEqual(['x', 'y'])
    expect((await suspendedAccountIds(adminWith({ data: null, error: { code: '42P01' } }).client)).size).toBe(0)
  })
})
