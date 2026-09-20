import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveCapabilities } from '@/lib/auth/capabilities'
import type { AccountRole } from '@/lib/auth/roles'

const h = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  performCommentAction: vi.fn(),
}))

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireCapability: h.requireCapability,
  toErrorResponse: () => Response.json({ error: 'auth failed' }, { status: 403 }),
}))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ name: 'admin' }) }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { adminAction: {} },
}))
vi.mock('@/lib/comments/actions', () => ({ performCommentAction: h.performCommentAction }))

import { POST } from './route'

function as(role: AccountRole, overrides?: Record<string, boolean>) {
  h.requireCapability.mockResolvedValue({
    userId: 'u1',
    accountId: 'a1',
    role,
    capabilities: resolveCapabilities(role, overrides),
  })
}

const act = (action: string) =>
  POST(
    new Request('http://localhost/api/comments/c1/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, text: 'hi' }),
    }),
    { params: Promise.resolve({ id: 'c1' }) },
  )

beforeEach(() => {
  h.requireCapability.mockReset()
  h.performCommentAction.mockReset()
  h.performCommentAction.mockResolvedValue({ ok: true, comment: { id: 'c1' } })
})

describe('POST /api/comments/[id]/action', () => {
  it('needs comments.moderate', async () => {
    as('agent')
    await act('hide')
    expect(h.requireCapability).toHaveBeenCalledWith('comments.moderate')
  })

  it('lets an agent reply, hide and unhide', async () => {
    as('agent')
    for (const action of ['reply', 'private_reply', 'hide', 'unhide']) {
      expect((await act(action)).status).toBe(200)
    }
    expect(h.performCommentAction).toHaveBeenCalledTimes(4)
  })

  it('refuses delete for an agent with a 403, before touching the provider', async () => {
    as('agent')
    const res = await act('delete')
    expect(res.status).toBe(403)
    expect(h.performCommentAction).not.toHaveBeenCalled()
  })

  it('lets an admin and an owner delete', async () => {
    for (const role of ['admin', 'owner'] as const) {
      as(role)
      expect((await act('delete')).status).toBe(200)
    }
  })

  it('refuses delete for an admin whose comments.delete was switched off', async () => {
    as('admin', { 'comments.delete': false })
    expect((await act('delete')).status).toBe(403)
    expect((await act('hide')).status).toBe(200)
  })

  it('lets an agent delete once comments.delete is granted to the agent role', async () => {
    as('agent', { 'comments.delete': true })
    expect((await act('delete')).status).toBe(200)
  })

  it('rejects an unknown action with 400', async () => {
    as('admin')
    expect((await act('explode')).status).toBe(400)
  })
})
