import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  taken: [] as { id: string }[],
  existing: null as { id: string; pubsub_verify_token: string; history_id: string | null } | null,
  saveError: null as { code?: string; message: string } | null,
  writes: [] as { op: string; row: Record<string, unknown> }[],
  filters: [] as { fn: string; args: unknown[] }[],
  watch: vi.fn(),
  completed: vi.fn(),
  failed: vi.fn(),
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const chain: Record<string, unknown> = {}
      const rec = (fn: string) => (...args: unknown[]) => (h.filters.push({ fn, args }), chain)
      chain.select = rec('select')
      chain.ilike = rec('ilike')
      chain.neq = rec('neq')
      chain.eq = rec('eq')
      chain.limit = rec('limit')
      // the "is it taken by another workspace" read resolves as a list; the
      // "existing row for this workspace" read resolves through maybeSingle
      chain.maybeSingle = async () => ({ data: h.existing, error: null })
      chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: h.taken, error: null })
      chain.insert = async (row: Record<string, unknown>) => (h.writes.push({ op: 'insert', row }), { error: h.saveError })
      chain.update = (row: Record<string, unknown>) => ({
        eq: async () => (h.writes.push({ op: 'update', row }), { error: h.saveError }),
      })
      return chain
    },
  }),
}))
vi.mock('@/lib/gmail/oauth', () => ({
  exchangeCodeForTokens: async () => ({ accessToken: 'at', refreshToken: 'rt', expiresInSeconds: 3600 }),
  getUserEmailAddress: async () => 'Shared.Box@Example.com',
  getOAuthBaseUrl: () => 'https://halo.example.com',
}))
vi.mock('@/lib/gmail/gmail-api', () => ({
  watchMailbox: h.watch,
  getCurrentHistoryId: async () => 'h1',
}))
vi.mock('@/lib/gmail/oauth-connect', () => ({
  findPendingGmailConnectionByState: async () => ({ id: 'pend-1', account_id: 'acc-1', initiated_by_user_id: 'u1' }),
  markGmailConnectionCompleted: h.completed,
  markGmailConnectionFailed: h.failed,
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: (s: string) => `enc:${s}` }))

import { GET } from './route'

const call = () => GET(new Request('https://halo.example.com/api/account/channels/gmail/oauth/callback?code=c&state=s'))
const location = (res: Response) => new URL(res.headers.get('location') ?? '', 'https://halo.example.com')

beforeEach(() => {
  h.taken = []
  h.existing = null
  h.saveError = null
  h.writes = []
  h.filters = []
  h.watch.mockReset()
  h.watch.mockResolvedValue({ expiration: '2026-10-09T00:00:00Z', historyId: 'h' })
  h.completed.mockReset()
  h.failed.mockReset()
  delete process.env.GMAIL_PUBSUB_TOPIC
})

describe('GET /api/account/channels/gmail/oauth/callback: one workspace per mailbox', () => {
  it('connects a mailbox no other workspace holds', async () => {
    const res = await call()
    expect(location(res).searchParams.get('connected')).toBe('1')
    expect(h.writes).toHaveLength(1)
    expect(h.completed).toHaveBeenCalled()
  })

  it('looks for another workspace\'s row case-insensitively and with wildcards escaped', async () => {
    await call()
    expect(h.filters).toContainEqual({ fn: 'ilike', args: ['email_address', 'Shared.Box@Example.com'] })
    expect(h.filters).toContainEqual({ fn: 'neq', args: ['account_id', 'acc-1'] })
  })

  it('refuses a mailbox that belongs to another workspace, before registering a push watch or saving anything', async () => {
    process.env.GMAIL_PUBSUB_TOPIC = 'projects/p/topics/t'
    h.taken = [{ id: 'other-cfg' }]
    const res = await call()
    expect(location(res).searchParams.get('oauth_error')).toBe('mailbox_in_use')
    expect(h.watch).not.toHaveBeenCalled()
    expect(h.writes).toEqual([])
    expect(h.failed).toHaveBeenCalled()
    expect(h.completed).not.toHaveBeenCalled()
  })

  it('maps a lost race (unique violation on save) to the same message', async () => {
    h.saveError = { code: '23505', message: 'duplicate key' }
    const res = await call()
    expect(location(res).searchParams.get('oauth_error')).toBe('mailbox_in_use')
    expect(h.completed).not.toHaveBeenCalled()
  })

  it('still treats any other save error as a failed connection', async () => {
    h.saveError = { code: 'XX000', message: 'boom' }
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await call()
      expect(location(res).searchParams.get('oauth_error')).toBe('unknown')
    } finally {
      err.mockRestore()
    }
  })
})
