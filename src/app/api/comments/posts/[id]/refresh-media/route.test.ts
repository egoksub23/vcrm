import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ getCurrentAccount: vi.fn(), refresh: vi.fn(), limit: vi.fn() }))

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: h.getCurrentAccount,
  toErrorResponse: () => Response.json({ error: 'auth failed' }, { status: 401 }),
}))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ admin: true }) }))
vi.mock('@/lib/comments/refresh-post-media', () => ({ refreshPostMedia: h.refresh }))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: h.limit, rateLimitResponse: () => Response.json({ error: 'slow down' }, { status: 429 }) }))

import { POST } from './route'

const call = (id = 'post-1') => POST(new Request('http://x/api/comments/posts/post-1/refresh-media', { method: 'POST' }), { params: Promise.resolve({ id }) })

beforeEach(() => {
  h.getCurrentAccount.mockReset().mockResolvedValue({ accountId: 'acct-1', userId: 'u1' })
  h.refresh.mockReset().mockResolvedValue({ ok: true, mediaUrl: 'https://halo.test/p.jpg', changed: true })
  h.limit.mockReset().mockReturnValue({ success: true })
})

describe('POST /api/comments/posts/[id]/refresh-media', () => {
  it("repairs a post of the caller's own workspace and answers with the new link", async () => {
    const res = await call('post-9')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ media_url: 'https://halo.test/p.jpg', changed: true })
    expect(h.refresh).toHaveBeenCalledWith({ admin: true }, 'acct-1', 'post-9')
  })

  it('is rate limited per person', async () => {
    h.limit.mockReturnValue({ success: false })
    expect((await call()).status).toBe(429)
    expect(h.limit).toHaveBeenCalledWith('comment-media:u1', { limit: 60, windowMs: 60_000 })
    expect(h.refresh).not.toHaveBeenCalled()
  })

  it('says 404 for a post that is not theirs, and 409 with a reason for one that cannot be repaired', async () => {
    h.refresh.mockResolvedValue({ ok: false, reason: 'not_found' })
    expect((await call()).status).toBe(404)
    h.refresh.mockResolvedValue({ ok: false, reason: 'not_connected' })
    const res = await call()
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ reason: 'not_connected' })
  })

  it('needs a signed-in member', async () => {
    h.getCurrentAccount.mockRejectedValue(new Error('no session'))
    expect((await call()).status).toBe(401)
    expect(h.refresh).not.toHaveBeenCalled()
  })
})
