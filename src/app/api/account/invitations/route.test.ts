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

const post = (role: unknown) =>
  POST(
    new Request('http://localhost/api/account/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', host: 'crm.test' },
      body: JSON.stringify({ role }),
    }),
  )

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

  it('refuses a caller without the capability', async () => {
    h.requireCapability.mockRejectedValue(new Error('nope'))
    expect((await post('agent')).status).toBe(403)
    expect(h.insert).not.toHaveBeenCalled()
  })
})
