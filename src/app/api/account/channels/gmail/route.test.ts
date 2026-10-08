import { beforeEach, describe, expect, it, vi } from 'vitest'

// GET / PATCH /api/account/channels/gmail: the connection status, and the two independent switches of the mailbox. `enabled` is the master pause
// (nothing in, nothing out); `inbox_enabled` is "use this mailbox for the customer care inbox" (off stops the Gmail push watch). The Google side of the
// inbox switch has its own tests (lib/gmail/inbox-switch.test.ts); here the route's validation, the wiring and the answers.

const h = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  getCurrentAccount: vi.fn(),
  setInbox: vi.fn(),
  row: null as Record<string, unknown> | null,
  updates: [] as { table: string; patch: Record<string, unknown>; account: unknown }[],
  updateError: null as { message: string } | null,
}))

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: h.getCurrentAccount,
  requireCapability: h.requireCapability,
  toErrorResponse: () => Response.json({ error: 'auth failed' }, { status: 403 }),
}))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({}) }))
vi.mock('@/lib/gmail/token', () => ({ getValidAccessToken: async () => 'tok' }))
vi.mock('@/lib/gmail/gmail-api', () => ({ stopWatch: async () => true }))
vi.mock('@/lib/gmail/oauth', () => ({ getOAuthBaseUrl: () => 'https://halo.test' }))
vi.mock('@/lib/gmail/inbox-switch', () => ({
  realGmailInboxDeps: (setFlag: unknown) => ({ setFlag }),
  setGmailInbox: h.setInbox,
}))

import { GET, PATCH } from './route'

function client() {
  return {
    from: (table: string) => {
      const b = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({ data: h.row, error: null }),
        update: (patch: Record<string, unknown>) => ({
          eq: async (_c: string, account: unknown) => {
            h.updates.push({ table, patch, account })
            return { error: h.updateError }
          },
        }),
      }
      return b
    },
  }
}

const patch = (body: unknown) =>
  PATCH(new Request('https://halo.test/api/account/channels/gmail', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }))

beforeEach(() => {
  h.row = null
  h.updates = []
  h.updateError = null
  h.setInbox.mockReset()
  h.requireCapability.mockReset().mockResolvedValue({ supabase: client(), accountId: 'acc-1' })
  h.getCurrentAccount.mockReset().mockResolvedValue({ supabase: client(), accountId: 'acc-1' })
})

describe('GET /api/account/channels/gmail', () => {
  const base = { email_address: 'care@vircle.com', connected_at: '2026-10-01T00:00:00Z', needs_reauth: false, status: 'connected', watch_expiration: '2026-10-09T00:00:00Z', pubsub_verify_token: 'tok-1', enabled: true, inbox_enabled: true }

  it('reports both switches and that Halo can send', async () => {
    h.row = base
    expect(await (await GET(new Request('https://halo.test/api/account/channels/gmail'))).json()).toMatchObject({ connected: true, email_address: 'care@vircle.com', enabled: true, inbox_enabled: true, send_problem: null })
  })

  it('says a mailbox whose inbox is off can still send; the pause and a reconnect are what stop it', async () => {
    const get = async () => (await GET(new Request('https://halo.test/api/account/channels/gmail'))).json()
    h.row = { ...base, inbox_enabled: false, watch_expiration: null }
    expect(await get()).toMatchObject({ inbox_enabled: false, send_problem: null })
    h.row = { ...base, enabled: false }
    expect(await get()).toMatchObject({ enabled: false, send_problem: 'paused' })
    h.row = { ...base, needs_reauth: true }
    expect(await get()).toMatchObject({ send_problem: 'reconnect' })
  })

  it('answers not connected without a row', async () => {
    expect(await (await GET(new Request('https://halo.test/api/account/channels/gmail'))).json()).toMatchObject({ connected: false, status: 'disconnected', push_endpoint_url: null })
  })
})

describe('PATCH /api/account/channels/gmail', () => {
  it('needs channels.manage', async () => {
    h.requireCapability.mockRejectedValue(new Error('forbidden'))
    expect((await patch({ enabled: false })).status).toBe(403)
    expect(h.requireCapability).toHaveBeenCalledWith('channels.manage')
    expect(h.updates).toEqual([])
    expect(h.setInbox).not.toHaveBeenCalled()
  })

  it('pauses the whole mailbox with { enabled } and does not touch the watch', async () => {
    const res = await patch({ enabled: false })
    expect(await res.json()).toEqual({ success: true, enabled: false })
    expect(h.updates).toEqual([{ table: 'gmail_config', patch: { enabled: false }, account: 'acc-1' }])
    expect(h.setInbox).not.toHaveBeenCalled()
  })

  it('switches the inbox off with { inbox_enabled } and leaves the pause alone', async () => {
    h.setInbox.mockResolvedValue({ ok: true, inbox_enabled: false, watch: 'stopped' })
    const res = await patch({ inbox_enabled: false })
    expect(await res.json()).toEqual({ success: true, inbox_enabled: false, watch: 'stopped' })
    expect(h.setInbox).toHaveBeenCalledWith({ accountId: 'acc-1', enabled: false }, expect.anything())
    expect(h.updates).toEqual([])
  })

  it('writes the inbox flag as the signed-in person, to this workspace\'s row only', async () => {
    h.setInbox.mockImplementation(async (_args: unknown, deps: { setFlag: (a: string, v: boolean) => Promise<unknown> }) => {
      expect(await deps.setFlag('acc-1', true)).toBeNull()
      return { ok: true, inbox_enabled: true, watch: 'started' }
    })
    await patch({ inbox_enabled: true })
    expect(h.updates).toEqual([{ table: 'gmail_config', patch: { inbox_enabled: true }, account: 'acc-1' }])
  })

  it('takes both switches in one call, the pause first', async () => {
    h.setInbox.mockResolvedValue({ ok: true, inbox_enabled: true, watch: 'started' })
    const res = await patch({ enabled: true, inbox_enabled: true })
    expect(await res.json()).toEqual({ success: true, enabled: true, inbox_enabled: true, watch: 'started' })
  })

  it('answers with the switch\'s own refusal', async () => {
    h.setInbox.mockResolvedValue({ ok: false, status: 409, code: 'needs_reconnect', error: 'Reconnect the mailbox first, then switch the Gmail inbox on.' })
    const res = await patch({ inbox_enabled: true })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Reconnect the mailbox first, then switch the Gmail inbox on.', code: 'needs_reconnect' })
  })

  it('rejects a body that has neither switch, or a switch that is not a boolean', async () => {
    expect((await patch({})).status).toBe(400)
    expect((await patch('not json')).status).toBe(400)
    expect((await patch({ enabled: 'yes' })).status).toBe(400)
    expect((await patch({ inbox_enabled: null })).status).toBe(400)
    expect(h.updates).toEqual([])
    expect(h.setInbox).not.toHaveBeenCalled()
  })
})
