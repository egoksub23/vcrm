import { beforeEach, describe, expect, it, vi } from 'vitest'

// GET / PATCH /api/account/channels/email: the connection status, and the two independent switches of the mailbox. `enabled` is the master pause
// (nothing in, nothing out); `inbox_enabled` is "use this mailbox for the customer care inbox" (off stops the Graph subscription). The Microsoft side
// of the inbox switch has its own tests (lib/ms365/inbox-switch.test.ts); here the route's validation, the wiring and the answers.

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
vi.mock('@/lib/ms365/token', () => ({ getValidAccessToken: async () => 'tok' }))
vi.mock('@/lib/ms365/mail-api', () => ({ deleteSubscription: async () => true }))
vi.mock('@/lib/ms365/oauth', () => ({ getOAuthBaseUrl: () => 'https://halo.test' }))
vi.mock('@/lib/ms365/inbox-switch', () => ({
  // the dependencies the route builds are handed to the switch: keep them so a test can use the flag writer
  realInboxSwitchDeps: (setFlag: unknown) => ({ setFlag }),
  setMs365Inbox: h.setInbox,
}))

import { GET, PATCH } from './route'

/** A stand-in for the signed-in person's own client: one table, the select of GET and the update of PATCH. */
function client() {
  return {
    from: (table: string) => {
      const b = {
        select: () => b,
        eq: (_c: string, v: unknown) => ((b as { _account?: unknown })._account = v, b),
        maybeSingle: async () => ({ data: h.row, error: null }),
        update: (patch: Record<string, unknown>) => {
          const u = {
            eq: async (_c: string, account: unknown) => {
              h.updates.push({ table, patch, account })
              return { error: h.updateError }
            },
          }
          return u
        },
      }
      return b
    },
  }
}

const patch = (body: unknown) =>
  PATCH(new Request('https://halo.test/api/account/channels/email', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }))

beforeEach(() => {
  h.row = null
  h.updates = []
  h.updateError = null
  h.setInbox.mockReset()
  h.requireCapability.mockReset().mockResolvedValue({ supabase: client(), accountId: 'acc-1' })
  h.getCurrentAccount.mockReset().mockResolvedValue({ supabase: client(), accountId: 'acc-1' })
})

describe('GET /api/account/channels/email', () => {
  const base = { mailbox_address: 'support@vircle.com', connected_at: '2026-10-01T00:00:00Z', needs_reauth: false, status: 'connected', enabled: true, inbox_enabled: true }

  it('reports both switches and that Halo can send, never a token', async () => {
    h.row = { ...base, access_token: 'SECRET' }
    const body = await (await GET()).json()
    expect(body).toMatchObject({ connected: true, mailbox_address: 'support@vircle.com', enabled: true, inbox_enabled: true, send_problem: null })
    expect(JSON.stringify(body)).not.toContain('SECRET')
  })

  it('says a mailbox whose inbox is off can still send (the inbox switch is not a sending problem)', async () => {
    h.row = { ...base, inbox_enabled: false }
    expect(await (await GET()).json()).toMatchObject({ enabled: true, inbox_enabled: false, send_problem: null })
  })

  it('names why Halo cannot send: the master pause, or a mailbox that needs reconnecting', async () => {
    h.row = { ...base, enabled: false }
    expect(await (await GET()).json()).toMatchObject({ enabled: false, inbox_enabled: true, send_problem: 'paused' })
    h.row = { ...base, needs_reauth: true }
    expect(await (await GET()).json()).toMatchObject({ send_problem: 'reconnect' })
    h.row = { ...base, enabled: false, inbox_enabled: false }
    expect(await (await GET()).json()).toMatchObject({ enabled: false, inbox_enabled: false, send_problem: 'paused' })
  })

  it('answers not connected without a row', async () => {
    expect(await (await GET()).json()).toEqual({ connected: false, needs_reauth: false, status: 'disconnected' })
  })
})

describe('PATCH /api/account/channels/email', () => {
  it('needs channels.manage', async () => {
    h.requireCapability.mockRejectedValue(new Error('forbidden'))
    expect((await patch({ enabled: false })).status).toBe(403)
    expect(h.requireCapability).toHaveBeenCalledWith('channels.manage')
    expect(h.updates).toEqual([])
    expect(h.setInbox).not.toHaveBeenCalled()
  })

  it('pauses the whole mailbox with { enabled } and does not touch the subscription', async () => {
    const res = await patch({ enabled: false })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, enabled: false })
    expect(h.updates).toEqual([{ table: 'email_config', patch: { enabled: false }, account: 'acc-1' }])
    expect(h.setInbox).not.toHaveBeenCalled()
  })

  it('switches the inbox off with { inbox_enabled } and leaves the pause alone', async () => {
    h.setInbox.mockResolvedValue({ ok: true, inbox_enabled: false, subscription: 'stopped' })
    const res = await patch({ inbox_enabled: false })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, inbox_enabled: false, subscription: 'stopped' })
    expect(h.setInbox).toHaveBeenCalledWith({ accountId: 'acc-1', enabled: false, baseUrl: 'https://halo.test' }, expect.anything())
    expect(h.updates).toEqual([])
  })

  it('writes the inbox flag as the signed-in person, to this workspace\'s row only (so the audit trail names them)', async () => {
    h.setInbox.mockImplementation(async (_args: unknown, deps: { setFlag: (a: string, v: boolean) => Promise<unknown> }) => {
      expect(await deps.setFlag('acc-1', true)).toBeNull()
      return { ok: true, inbox_enabled: true, subscription: 'started' }
    })
    await patch({ inbox_enabled: true })
    expect(h.updates).toEqual([{ table: 'email_config', patch: { inbox_enabled: true }, account: 'acc-1' }])
    h.updateError = { message: 'rls' }
    h.setInbox.mockImplementation(async (_args: unknown, deps: { setFlag: (a: string, v: boolean) => Promise<unknown> }) => {
      expect(await deps.setFlag('acc-1', true)).toEqual({ message: 'rls' })
      return { ok: false, status: 500, code: 'save_failed', error: 'Could not switch the email inbox on.' }
    })
    expect((await patch({ inbox_enabled: true })).status).toBe(500)
  })

  it('takes both switches in one call, the pause first', async () => {
    h.setInbox.mockResolvedValue({ ok: true, inbox_enabled: true, subscription: 'started' })
    const res = await patch({ enabled: true, inbox_enabled: true })
    expect(await res.json()).toEqual({ success: true, enabled: true, inbox_enabled: true, subscription: 'started' })
    expect(h.updates).toHaveLength(1)
    expect(h.setInbox).toHaveBeenCalledTimes(1)
  })

  it('answers with the switch\'s own refusal: not connected, needs a reconnect, Graph failed', async () => {
    for (const refusal of [
      { status: 404, code: 'not_connected', error: 'Email is not connected. Connect it in Settings > Channels first.' },
      { status: 409, code: 'needs_reconnect', error: 'Reconnect the mailbox first, then switch the email inbox on.' },
      { status: 502, code: 'subscription_failed', error: 'Could not start receiving email from Microsoft 365. Try again, or reconnect the mailbox.' },
    ]) {
      h.setInbox.mockResolvedValue({ ok: false, ...refusal })
      const res = await patch({ inbox_enabled: true })
      expect(res.status).toBe(refusal.status)
      expect(await res.json()).toEqual({ error: refusal.error, code: refusal.code })
    }
  })

  it('rejects a body that has neither switch, or a switch that is not a boolean', async () => {
    expect((await patch({})).status).toBe(400)
    expect((await patch('not json')).status).toBe(400)
    expect((await patch({ enabled: 'yes' })).status).toBe(400)
    const res = await patch({ inbox_enabled: 1 })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/inbox_enabled must be a boolean/)
    expect(h.updates).toEqual([])
    expect(h.setInbox).not.toHaveBeenCalled()
  })

  it('does not run the inbox switch when the pause update failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    h.updateError = { message: 'rls' }
    const res = await patch({ enabled: false, inbox_enabled: false })
    expect(res.status).toBe(500)
    expect(h.setInbox).not.toHaveBeenCalled()
  })
})
