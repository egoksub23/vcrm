import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  pending: null as Record<string, unknown> | null,
  owns: true,
  exchange: vi.fn(),
}))

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({}) }))
vi.mock('@/lib/meta/oauth', () => ({
  exchangeCodeForUserToken: h.exchange,
  exchangeForLongLivedToken: vi.fn(),
  getOAuthBaseUrl: () => 'https://halo.example.com',
  getPageAccessToken: vi.fn(),
  listUserPages: vi.fn(),
}))
vi.mock('@/lib/meta/oauth-connect', () => ({
  findPendingConnectionByState: async () => h.pending,
  markAwaitingPageSelection: vi.fn(),
  markCompleted: vi.fn(),
  markFailed: vi.fn(),
  storeLongLivedToken: vi.fn(),
}))
vi.mock('@/lib/oauth/session-binding', () => ({ sessionOwnsPending: async () => h.owns }))
vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: (s: string) => `enc:${s}` }))

import { GET } from './route'

const call = () =>
  GET(new Request('https://halo.example.com/api/account/channels/messenger/oauth/callback?code=c&state=s'))
const err = (res: Response) => new URL(res.headers.get('location') ?? '', 'https://halo.example.com').searchParams.get('oauth_error')

beforeEach(() => {
  h.pending = {
    id: 'p1',
    account_id: 'acc-1',
    initiated_by_user_id: 'u1',
    channel: 'messenger',
    status: 'pending',
  }
  h.owns = true
  h.exchange.mockReset()
  h.exchange.mockRejectedValue(new Error('stop here'))
})

describe('GET /api/account/channels/messenger/oauth/callback: state binding', () => {
  it('goes on to exchange the code for the person who started the connection', async () => {
    await call()
    expect(h.exchange).toHaveBeenCalled()
  })

  it('refuses a callback opened by someone else, before any code is exchanged', async () => {
    h.owns = false
    const res = await call()
    expect(err(res)).toBe('invalid_state')
    expect(h.exchange).not.toHaveBeenCalled()
  })

  it('refuses a state that was already used', async () => {
    h.pending = { ...h.pending!, status: 'awaiting_page_selection' }
    const res = await call()
    expect(err(res)).toBe('invalid_state')
    expect(h.exchange).not.toHaveBeenCalled()
  })

  it('refuses an unknown or expired state', async () => {
    h.pending = null
    const res = await call()
    expect(err(res)).toBe('invalid_state')
    expect(h.exchange).not.toHaveBeenCalled()
  })
})
