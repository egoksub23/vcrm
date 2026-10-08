import { beforeEach, describe, expect, it, vi } from 'vitest'

// The heartbeat is pinged whenever an agent opens the Inbox or an email conversation. For a mailbox that is not used for the customer care inbox
// (inbox_enabled false, migration 179) there is no subscription to keep alive: it answers with a plain skip, claims nothing, creates nothing and logs no
// problem.

const h = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  claimed: null as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
  renew: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: async () => ({ accountId: 'A' }),
  toErrorResponse: () => Response.json({ error: 'auth failed' }, { status: 401 }),
}))
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => {
    const chain: Record<string, unknown> = {}
    chain.select = () => chain
    chain.eq = () => chain
    chain.or = () => chain
    chain.update = (patch: Record<string, unknown>) => (h.updates.push(patch), chain)
    chain.maybeSingle = async () => ({ data: h.updates.length ? h.claimed : h.config })
    return { from: () => chain }
  },
}))
vi.mock('@/lib/ms365/oauth', () => ({ getOAuthBaseUrl: () => 'https://halo.test' }))
vi.mock('@/lib/ms365/subscription-renewal', () => ({ renewMailboxSubscription: (...a: unknown[]) => h.renew(...a) }))

import { POST } from './route'

const ping = async () => (await POST(new Request('https://halo.test/api/email/subscription-heartbeat', { method: 'POST' }))).json()

beforeEach(() => {
  h.config = null
  h.claimed = null
  h.updates = []
  h.renew.mockReset().mockResolvedValue({ subscriptionId: 's', expiresAt: 'x', recreated: false })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('the subscription heartbeat', () => {
  it('skips when no mailbox is connected', async () => {
    expect(await ping()).toEqual({ skipped: true, reason: 'not_connected' })
  })

  it('skips cleanly when the mailbox is not used for the customer care inbox: nothing claimed, nothing created, nothing logged', async () => {
    h.config = { id: 'e1', account_id: 'A', inbox_enabled: false, subscription_id: null }
    expect(await ping()).toEqual({ skipped: true, reason: 'inbox_off' })
    expect(h.updates).toEqual([])
    expect(h.renew).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
  })

  it('skips the same way for a paused mailbox whose inbox is also off', async () => {
    h.config = { id: 'e1', account_id: 'A', enabled: false, inbox_enabled: false }
    expect(await ping()).toEqual({ skipped: true, reason: 'inbox_off' })
  })

  it('renews as before when the inbox is on, or the column does not exist yet', async () => {
    for (const config of [{ id: 'e1', account_id: 'A', inbox_enabled: true }, { id: 'e1', account_id: 'A' }]) {
      h.updates = []
      h.config = config
      h.claimed = config
      const body = await ping()
      expect(body).toMatchObject({ skipped: false, subscriptionId: 's' })
      expect(h.renew).toHaveBeenCalled()
    }
  })

  it('a failed renewal of a mailbox that should have a subscription is still logged and answered as before', async () => {
    h.config = { id: 'e1', account_id: 'A', inbox_enabled: true }
    h.claimed = h.config
    h.renew.mockRejectedValue(new Error('Graph down'))
    expect(await ping()).toEqual({ skipped: false, error: 'renew_failed' })
    expect(console.error).toHaveBeenCalled()
  })
})
