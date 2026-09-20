import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  insert: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireCapability: h.requireCapability,
  toErrorResponse: () => Response.json({ error: 'auth failed' }, { status: 403 }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { adminAction: {} },
}))

import { POST } from './route'

function ctx(role: string) {
  const single = vi.fn(async () => ({
    data: { id: 'inv-1', role: 'agent', label: null, expires_at: 'x', created_at: 'y' },
    error: null,
  }))
  h.insert.mockReturnValue({ select: () => ({ single }) })
  return {
    supabase: { from: () => ({ insert: h.insert }) },
    userId: 'u1',
    accountId: 'a1',
    role,
  }
}

const post = (role: unknown, extra: Record<string, unknown> = {}) =>
  POST(
    new Request('http://localhost/api/account/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', host: 'crm.test' },
      body: JSON.stringify({ role, ...extra }),
    }),
  )

const TEAM_A = '11111111-1111-4111-8111-111111111111'
const TEAM_B = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  h.requireCapability.mockReset()
  h.insert.mockReset()
})

describe('POST /api/account/invitations', () => {
  it('needs the members.invite capability', async () => {
    h.requireCapability.mockResolvedValue(ctx('admin'))
    await post('agent')
    expect(h.requireCapability).toHaveBeenCalledWith('members.invite')
  })

  it('lets an admin invite an agent or a viewer', async () => {
    for (const role of ['agent', 'viewer']) {
      h.requireCapability.mockResolvedValue(ctx('admin'))
      const res = await post(role)
      expect(res.status).toBe(201)
    }
    expect(h.insert).toHaveBeenCalledTimes(2)
  })

  it('refuses an admin who invites an admin, with a 403 before anything is inserted', async () => {
    h.requireCapability.mockResolvedValue(ctx('admin'))
    const res = await post('admin')
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/at or above your own role/i)
    expect(h.insert).not.toHaveBeenCalled()
  })

  it('lets an owner invite an admin, an agent or a viewer', async () => {
    for (const role of ['admin', 'agent', 'viewer']) {
      h.requireCapability.mockResolvedValue(ctx('owner'))
      expect((await post(role)).status).toBe(201)
    }
  })

  it('never lets anyone invite an owner (400)', async () => {
    h.requireCapability.mockResolvedValue(ctx('owner'))
    expect((await post('owner')).status).toBe(400)
    expect(h.insert).not.toHaveBeenCalled()
  })

  it('stores the teams the invitee joins (de-duplicated)', async () => {
    h.requireCapability.mockResolvedValue(ctx('admin'))
    const res = await post('agent', { teamIds: [TEAM_A, TEAM_B, TEAM_A] })
    expect(res.status).toBe(201)
    expect(h.insert).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'agent', team_ids: [TEAM_A, TEAM_B] }),
    )
  })

  it('defaults to no teams when none are sent', async () => {
    h.requireCapability.mockResolvedValue(ctx('admin'))
    await post('agent')
    expect(h.insert).toHaveBeenCalledWith(expect.objectContaining({ team_ids: [] }))
  })

  it('rejects malformed team ids with a 400 before inserting', async () => {
    h.requireCapability.mockResolvedValue(ctx('admin'))
    expect((await post('agent', { teamIds: ['nope'] })).status).toBe(400)
    expect((await post('agent', { teamIds: TEAM_A })).status).toBe(400)
    expect(h.insert).not.toHaveBeenCalled()
  })

  it('still refuses a role at or above the inviter even with teams', async () => {
    h.requireCapability.mockResolvedValue(ctx('admin'))
    const res = await post('admin', { teamIds: [TEAM_A] })
    expect(res.status).toBe(403)
    expect(h.insert).not.toHaveBeenCalled()
  })

  it('refuses a caller without the capability', async () => {
    h.requireCapability.mockRejectedValue(new Error('nope'))
    expect((await post('agent')).status).toBe(403)
    expect(h.insert).not.toHaveBeenCalled()
  })
})
