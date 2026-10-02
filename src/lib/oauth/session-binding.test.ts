import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  require: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({ requireCapability: h.require }))

import { sessionOwnsPending } from './session-binding'

const pending = { account_id: 'acc-1', initiated_by_user_id: 'u1' }

beforeEach(() => h.require.mockReset())

describe('sessionOwnsPending', () => {
  it('accepts the person who started the connection, in the same workspace', async () => {
    h.require.mockResolvedValue({ userId: 'u1', accountId: 'acc-1' })
    expect(await sessionOwnsPending(pending)).toBe(true)
    expect(h.require).toHaveBeenCalledWith('channels.manage')
  })

  it('rejects a different person in the same workspace (a forwarded link)', async () => {
    h.require.mockResolvedValue({ userId: 'u2', accountId: 'acc-1' })
    expect(await sessionOwnsPending(pending)).toBe(false)
  })

  it('rejects the same person signed in to a different workspace', async () => {
    h.require.mockResolvedValue({ userId: 'u1', accountId: 'acc-2' })
    expect(await sessionOwnsPending(pending)).toBe(false)
  })

  it('rejects a signed-out browser', async () => {
    h.require.mockRejectedValueOnce(new Error('unauthenticated'))
    expect(await sessionOwnsPending(pending)).toBe(false)
  })

  it('rejects a person who may no longer connect channels', async () => {
    h.require.mockRejectedValueOnce(new Error("missing capability 'channels.manage'"))
    expect(await sessionOwnsPending(pending)).toBe(false)
  })

  it('checks the capability the caller names', async () => {
    h.require.mockResolvedValue({ userId: 'u1', accountId: 'acc-1' })
    await sessionOwnsPending(pending, 'comments.moderate')
    expect(h.require).toHaveBeenCalledWith('comments.moderate')
  })
})
