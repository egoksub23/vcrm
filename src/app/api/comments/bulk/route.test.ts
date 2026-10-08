import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveCapabilities } from '@/lib/auth/capabilities'
import type { AccountRole } from '@/lib/auth/roles'

const h = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  runBulkOp: vi.fn(),
  rate: vi.fn(() => ({ success: true })),
}))

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireCapability: h.requireCapability,
  toErrorResponse: () => Response.json({ error: 'auth failed' }, { status: 403 }),
}))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ name: 'admin' }) }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: h.rate,
  rateLimitResponse: () => Response.json({ error: 'slow down' }, { status: 429 }),
  RATE_LIMITS: { adminAction: {} },
}))
vi.mock('@/lib/comments/actions', () => ({ performCommentAction: vi.fn() }))
vi.mock('@/lib/comments/bulk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/comments/bulk')>()),
  runBulkOp: h.runBulkOp,
}))

import { POST } from './route'

const userDb = { name: 'user' }
function as(role: AccountRole) {
  h.requireCapability.mockResolvedValue({
    userId: 'u1',
    accountId: 'a1',
    role,
    supabase: userDb,
    capabilities: resolveCapabilities(role),
  })
}
const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/comments/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )

beforeEach(() => {
  h.requireCapability.mockReset()
  h.runBulkOp.mockReset()
  h.rate.mockReset()
  h.rate.mockReturnValue({ success: true })
  h.runBulkOp.mockImplementation(async ({ ids }: { ids: string[] }) => ids.map((id) => ({ id, ok: true })))
})

describe('POST /api/comments/bulk', () => {
  it('needs comments.moderate', async () => {
    as('agent')
    await post({ op: 'resolve', ids: ['c1'] })
    expect(h.requireCapability).toHaveBeenCalledWith('comments.moderate')
  })

  it('refuses a caller without the capability', async () => {
    h.requireCapability.mockRejectedValue(new Error('denied'))
    const res = await post({ op: 'resolve', ids: ['c1'] })
    expect(res.status).toBe(403)
    expect(h.runBulkOp).not.toHaveBeenCalled()
  })

  it('runs the operation as the caller (their client for handled status, the service client for the provider) and returns one answer per comment', async () => {
    as('agent')
    const res = await post({ op: 'hide', ids: ['c1', 'c2'] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      results: [
        { id: 'c1', ok: true },
        { id: 'c2', ok: true },
      ],
    })
    expect(h.runBulkOp).toHaveBeenCalledWith({
      userDb,
      adminDb: { name: 'admin' },
      ctx: { accountId: 'a1', userId: 'u1' },
      op: 'hide',
      ids: ['c1', 'c2'],
    })
  })

  it('accepts the five operations and nothing else (no delete in bulk)', async () => {
    as('agent')
    for (const op of ['resolve', 'spam', 'reopen', 'hide', 'unhide']) {
      expect((await post({ op, ids: ['c1'] })).status).toBe(200)
    }
    for (const op of ['delete', 'reply', 'private_reply', '', undefined]) {
      expect((await post({ op, ids: ['c1'] })).status).toBe(400)
    }
  })

  it('validates the ids', async () => {
    as('agent')
    expect((await post({ op: 'resolve' })).status).toBe(400)
    expect((await post({ op: 'resolve', ids: [] })).status).toBe(400)
    expect((await post({ op: 'resolve', ids: 'c1' })).status).toBe(400)
    expect((await post({ op: 'resolve', ids: ['c1', 7] })).status).toBe(400)
    expect((await post({ op: 'resolve', ids: ['x'.repeat(65)] })).status).toBe(400)
    expect((await post('not json')).status).toBe(400)
    expect(h.runBulkOp).not.toHaveBeenCalled()
  })

  it('takes at most 50 ids in one request', async () => {
    as('agent')
    const ids = Array.from({ length: 51 }, (_, i) => `c${i}`)
    expect((await post({ op: 'resolve', ids })).status).toBe(400)
    expect((await post({ op: 'resolve', ids: ids.slice(0, 50) })).status).toBe(200)
  })

  it('is rate limited per person', async () => {
    as('agent')
    h.rate.mockReturnValue({ success: false })
    expect((await post({ op: 'resolve', ids: ['c1'] })).status).toBe(429)
    expect(h.rate).toHaveBeenCalledWith('comment-bulk:u1', expect.anything())
    expect(h.runBulkOp).not.toHaveBeenCalled()
  })
})
