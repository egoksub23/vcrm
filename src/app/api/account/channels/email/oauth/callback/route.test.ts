import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  taken: [] as { id: string }[],
  saveError: null as { code?: string; message: string } | null,
  writes: [] as { op: string; row: Record<string, unknown> }[],
  filters: [] as { fn: string; args: unknown[] }[],
  subscribe: vi.fn(),
  completed: vi.fn(),
  failed: vi.fn(),
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const chain: Record<string, unknown> = {}
      const rec = (fn: string) => (...args: unknown[]) => (h.filters.push({ fn, args }), chain)
      chain.select = rec('select')
      chain.neq = rec('neq')
      chain.eq = rec('eq')
      chain.limit = rec('limit')
      chain.maybeSingle = async () => ({ data: null, error: null })
      chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: h.taken, error: null })
      chain.insert = async (row: Record<string, unknown>) => (h.writes.push({ op: 'insert', row }), { error: h.saveError })
      chain.update = (row: Record<string, unknown>) => ({
        eq: async () => (h.writes.push({ op: 'update', row }), { error: h.saveError }),
      })
      return chain
    },
  }),
}))
vi.mock('@/lib/ms365/oauth', () => ({
  exchangeCodeForTokens: async () => ({ accessToken: 'at', refreshToken: 'rt', expiresInSeconds: 3600 }),
  getMailboxProfile: async () => ({ id: 'graph-user-1', address: 'box@example.com' }),
  getOAuthBaseUrl: () => 'https://halo.example.com',
}))
vi.mock('@/lib/ms365/mail-api', () => ({ createSubscription: h.subscribe }))
vi.mock('@/lib/ms365/oauth-connect', () => ({
  findPendingEmailConnectionByState: async () => ({ id: 'pend-1', account_id: 'acc-1', initiated_by_user_id: 'u1' }),
  markEmailConnectionCompleted: h.completed,
  markEmailConnectionFailed: h.failed,
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: (s: string) => `enc:${s}` }))

import { GET } from './route'

const call = () => GET(new Request('https://halo.example.com/api/account/channels/email/oauth/callback?code=c&state=s'))
const location = (res: Response) => new URL(res.headers.get('location') ?? '', 'https://halo.example.com')

beforeEach(() => {
  h.taken = []
  h.saveError = null
  h.writes = []
  h.filters = []
  h.subscribe.mockReset()
  h.subscribe.mockResolvedValue({ id: 'sub-1', expirationDateTime: '2026-10-05T00:00:00Z' })
  h.completed.mockReset()
  h.failed.mockReset()
})

describe('GET /api/account/channels/email/oauth/callback: one workspace per mailbox', () => {
  it('connects a mailbox no other workspace holds', async () => {
    const res = await call()
    expect(location(res).searchParams.get('connected')).toBe('1')
    expect(h.writes).toHaveLength(1)
  })

  it('looks for another workspace holding the same Graph mailbox id', async () => {
    await call()
    expect(h.filters).toContainEqual({ fn: 'eq', args: ['mailbox_user_id', 'graph-user-1'] })
    expect(h.filters).toContainEqual({ fn: 'neq', args: ['account_id', 'acc-1'] })
  })

  it('refuses a mailbox another workspace holds, before creating a subscription or saving', async () => {
    h.taken = [{ id: 'other-cfg' }]
    const res = await call()
    expect(location(res).searchParams.get('oauth_error')).toBe('mailbox_in_use')
    expect(h.subscribe).not.toHaveBeenCalled()
    expect(h.writes).toEqual([])
    expect(h.failed).toHaveBeenCalled()
  })

  it('maps a lost race (unique violation on save) to the same message', async () => {
    h.saveError = { code: '23505', message: 'duplicate key' }
    const res = await call()
    expect(location(res).searchParams.get('oauth_error')).toBe('mailbox_in_use')
    expect(h.completed).not.toHaveBeenCalled()
  })
})
