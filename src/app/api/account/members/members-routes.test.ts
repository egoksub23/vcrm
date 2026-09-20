import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  getCurrentAccount: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireCapability: h.requireCapability,
  getCurrentAccount: h.getCurrentAccount,
  toErrorResponse: () => Response.json({ error: 'auth failed' }, { status: 403 }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { adminAction: {} },
}))

import { GET } from './route'
import { DELETE, PATCH } from './[userId]/route'
import { POST as REMOVE } from './[userId]/remove/route'
import { PUT as SET_TEAMS } from './[userId]/teams/route'
import { POST as BULK } from './bulk-teams/route'

const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
const T1 = '33333333-3333-4333-8333-333333333333'
const T2 = '44444444-4444-4444-8444-444444444444'

function ctx(role = 'admin') {
  return {
    supabase: { rpc: h.rpc, from: h.from },
    userId: 'caller',
    accountId: 'acct',
    role,
  }
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
const params = (userId: string) => ({ params: Promise.resolve({ userId }) })

beforeEach(() => {
  h.requireCapability.mockReset()
  h.getCurrentAccount.mockReset()
  h.rpc.mockReset()
  h.from.mockReset()
})

describe('GET /api/account/members', () => {
  it('returns every member with all their teams from one RPC call', async () => {
    h.getCurrentAccount.mockResolvedValue(ctx())
    const eq = vi.fn(async () => ({ data: [], error: null }))
    h.from.mockReturnValue({ select: () => ({ eq }) })
    h.rpc.mockResolvedValue({
      data: [
        {
          user_id: U1,
          full_name: 'Ana',
          email: 'ana@x.io',
          avatar_url: null,
          role: 'agent',
          joined_at: '2026-01-01T00:00:00Z',
          last_active: null,
          teams: [
            { id: T1, name: 'Tech', color: '#111111' },
            { id: T2, name: 'Billing', color: '#222222' },
          ],
          open_conversations: 3,
          open_tickets: 1,
        },
        { user_id: U2, full_name: null, role: 'superadmin' },
        { user_id: 'x', full_name: 'No teams', role: 'viewer', teams: null },
      ],
      error: null,
    })

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(h.rpc).toHaveBeenCalledTimes(1)
    expect(h.rpc).toHaveBeenCalledWith('list_team_members')
    // The unknown role row is skipped, the rest keep their shape.
    expect(body.members).toHaveLength(2)
    expect(body.members[0].teams.map((t: { name: string }) => t.name)).toEqual(['Tech', 'Billing'])
    expect(body.members[0].open_conversations).toBe(3)
    expect(body.members[1].teams).toEqual([])
    expect(body.members[1].open_tickets).toBe(0)
    // Capability summary per role, out of the whole catalogue.
    expect(body.capabilityTotal).toBeGreaterThan(20)
    expect(body.capabilityCounts.owner).toBe(body.capabilityTotal)
    expect(body.capabilityCounts.viewer).toBeLessThan(body.capabilityCounts.admin)
  })

  it('answers 500 when the roster cannot be read', async () => {
    h.getCurrentAccount.mockResolvedValue(ctx())
    h.from.mockReturnValue({ select: () => ({ eq: async () => ({ data: [], error: null }) }) })
    h.rpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'boom' } })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await GET()).status).toBe(500)
    spy.mockRestore()
  })
})

describe('POST /api/account/members/[userId]/remove', () => {
  it('needs members.remove', async () => {
    h.requireCapability.mockResolvedValue(ctx())
    h.rpc.mockResolvedValue({ data: { removed: true }, error: null })
    await REMOVE(new Request('http://x', json({})), params(U1))
    expect(h.requireCapability).toHaveBeenCalledWith('members.remove')
  })

  it('unassigns by default and reports the counts', async () => {
    h.requireCapability.mockResolvedValue(ctx())
    h.rpc.mockResolvedValue({
      data: { removed: true, unassigned_conversations: 4, unassigned_tickets: 2 },
      error: null,
    })
    const res = await REMOVE(new Request('http://x', json({})), params(U1))
    expect(res.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledWith('remove_account_member', {
      p_user_id: U1,
      p_reassign_to: null,
    })
    expect(await res.json()).toMatchObject({
      ok: true,
      removed: true,
      unassignedConversations: 4,
      unassignedTickets: 2,
      reassignedTo: null,
    })
  })

  it('passes the chosen heir to the RPC', async () => {
    h.requireCapability.mockResolvedValue(ctx())
    h.rpc.mockResolvedValue({
      data: { removed: true, reassigned_conversations: 3, reassigned_tickets: 1, reassigned_to: U2 },
      error: null,
    })
    const res = await REMOVE(new Request('http://x', json({ reassignTo: U2 })), params(U1))
    expect(h.rpc).toHaveBeenCalledWith('remove_account_member', { p_user_id: U1, p_reassign_to: U2 })
    expect(await res.json()).toMatchObject({ reassignedConversations: 3, reassignedTickets: 1, reassignedTo: U2 })
  })

  it('rejects a malformed heir before calling the database', async () => {
    h.requireCapability.mockResolvedValue(ctx())
    expect((await REMOVE(new Request('http://x', json({ reassignTo: 'nope' })), params(U1))).status).toBe(400)
    expect((await REMOVE(new Request('http://x', json({ reassignTo: 5 })), params(U1))).status).toBe(400)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('maps the RPC refusals: hierarchy to 403, bad input to 400', async () => {
    h.requireCapability.mockResolvedValue(ctx())
    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'You can only remove members whose role is below your own' },
    })
    const denied = await REMOVE(new Request('http://x', json({})), params(U1))
    expect(denied.status).toBe(403)
    expect((await denied.json()).error).toMatch(/below your own/)

    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '22023', message: 'Cannot remove the account owner; transfer ownership first' },
    })
    expect((await REMOVE(new Request('http://x', json({})), params(U1))).status).toBe(400)
  })

  it('refuses a caller without the capability', async () => {
    h.requireCapability.mockRejectedValue(new Error('nope'))
    expect((await REMOVE(new Request('http://x', json({})), params(U1))).status).toBe(403)
    expect(h.rpc).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/account/members/[userId] (kept for older callers)', () => {
  it('still removes, and honours ?reassign_to=', async () => {
    h.requireCapability.mockResolvedValue(ctx())
    h.rpc.mockResolvedValue({ data: { removed: true }, error: null })
    const res = await DELETE(new Request(`http://x/api?reassign_to=${U2}`, { method: 'DELETE' }), params(U1))
    expect(res.status).toBe(200)
    expect(h.requireCapability).toHaveBeenCalledWith('members.remove')
    expect(h.rpc).toHaveBeenCalledWith('remove_account_member', { p_user_id: U1, p_reassign_to: U2 })
  })
})

describe('PATCH /api/account/members/[userId] (role change, unchanged)', () => {
  it('needs members.change-role and never promotes to owner', async () => {
    h.requireCapability.mockResolvedValue(ctx())
    const res = await PATCH(new Request('http://x', { ...json({ role: 'owner' }), method: 'PATCH' }), params(U1))
    expect(h.requireCapability).toHaveBeenCalledWith('members.change-role')
    expect(res.status).toBe(400)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('maps the below-your-own refusal to 403', async () => {
    h.requireCapability.mockResolvedValue(ctx())
    h.rpc.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'You can only assign roles below your own' },
    })
    const res = await PATCH(new Request('http://x', { ...json({ role: 'admin' }), method: 'PATCH' }), params(U1))
    expect(res.status).toBe(403)
  })
})

describe('PUT /api/account/members/[userId]/teams', () => {
  const put = (userId: string, body: unknown) =>
    SET_TEAMS(new Request('http://x', { ...json(body), method: 'PUT' }), params(userId))

  it('needs teams.manage and applies the whole set through the RPC', async () => {
    h.requireCapability.mockResolvedValue(ctx())
    h.rpc.mockResolvedValue({ data: { added: 1, removed: 2 }, error: null })
    const res = await put(U1, { team_ids: [T1, T2, T1] })
    expect(h.requireCapability).toHaveBeenCalledWith('teams.manage')
    expect(h.rpc).toHaveBeenCalledWith('set_member_teams', { p_user_id: U1, p_team_ids: [T1, T2] })
    expect(await res.json()).toEqual({ ok: true, added: 1, removed: 2 })
  })

  it('accepts an empty list (clears every team)', async () => {
    h.requireCapability.mockResolvedValue(ctx())
    h.rpc.mockResolvedValue({ data: { added: 0, removed: 3 }, error: null })
    expect((await put(U1, { team_ids: [] })).status).toBe(200)
    expect(h.rpc).toHaveBeenCalledWith('set_member_teams', { p_user_id: U1, p_team_ids: [] })
  })

  it('rejects a missing or malformed list and a bad member id', async () => {
    h.requireCapability.mockResolvedValue(ctx())
    expect((await put(U1, {})).status).toBe(400)
    expect((await put(U1, { team_ids: 'x' })).status).toBe(400)
    expect((await put(U1, { team_ids: ['nope'] })).status).toBe(400)
    expect((await put('not-a-uuid', { team_ids: [] })).status).toBe(404)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('maps a database refusal to 403', async () => {
    h.requireCapability.mockResolvedValue(ctx())
    h.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'nope' } })
    expect((await put(U1, { team_ids: [T1] })).status).toBe(403)
  })

  it('refuses a caller without the capability', async () => {
    h.requireCapability.mockRejectedValue(new Error('nope'))
    expect((await put(U1, { team_ids: [T1] })).status).toBe(403)
    expect(h.rpc).not.toHaveBeenCalled()
  })
})

describe('POST /api/account/members/bulk-teams', () => {
  const post = (body: unknown) => BULK(new Request('http://x', json(body)))

  it('needs teams.manage and forwards the change to the RPC', async () => {
    h.requireCapability.mockResolvedValue(ctx())
    h.rpc.mockResolvedValue({ data: { changed: 4 }, error: null })
    const res = await post({ action: 'add', user_ids: [U1, U2], team_ids: [T1, T2] })
    expect(h.requireCapability).toHaveBeenCalledWith('teams.manage')
    expect(h.rpc).toHaveBeenCalledWith('change_team_members', {
      p_user_ids: [U1, U2],
      p_team_ids: [T1, T2],
      p_action: 'add',
    })
    expect(await res.json()).toEqual({ ok: true, changed: 4 })
  })

  it('supports remove', async () => {
    h.requireCapability.mockResolvedValue(ctx())
    h.rpc.mockResolvedValue({ data: { changed: 1 }, error: null })
    await post({ action: 'remove', user_ids: [U1], team_ids: [T1] })
    expect(h.rpc).toHaveBeenCalledWith('change_team_members', expect.objectContaining({ p_action: 'remove' }))
  })

  it('rejects an unknown action, empty picks and bad ids with 400', async () => {
    h.requireCapability.mockResolvedValue(ctx())
    expect((await post({ action: 'purge', user_ids: [U1], team_ids: [T1] })).status).toBe(400)
    expect((await post({ action: 'add', user_ids: [], team_ids: [T1] })).status).toBe(400)
    expect((await post({ action: 'add', user_ids: [U1], team_ids: ['x'] })).status).toBe(400)
    expect((await post(null)).status).toBe(400)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('refuses a caller without the capability', async () => {
    h.requireCapability.mockRejectedValue(new Error('nope'))
    expect((await post({ action: 'add', user_ids: [U1], team_ids: [T1] })).status).toBe(403)
    expect(h.rpc).not.toHaveBeenCalled()
  })
})
