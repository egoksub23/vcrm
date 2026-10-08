import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ getCurrentAccount: vi.fn(), rpc: vi.fn() }))

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: h.getCurrentAccount,
  toErrorResponse: () => Response.json({ error: 'auth failed' }, { status: 401 }),
}))

import { POST } from './route'

const ID = '0b5d5f1e-2a9c-4f4e-9d77-3a1c3d3c8a10'
const post = (id = ID) => POST(new Request(`http://localhost/api/comments/posts/${id}/seen`, { method: 'POST' }), { params: Promise.resolve({ id }) })

beforeEach(() => {
  h.getCurrentAccount.mockReset()
  h.rpc.mockReset()
  h.getCurrentAccount.mockResolvedValue({ supabase: { rpc: h.rpc }, accountId: 'a1', userId: 'u1' })
})

describe('POST /api/comments/posts/[id]/seen', () => {
  it('records that the caller opened the post, through the function that runs as them', async () => {
    h.rpc.mockResolvedValue({ data: '2026-10-08T01:02:03Z', error: null })
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ seen_at: '2026-10-08T01:02:03Z' })
    expect(h.rpc).toHaveBeenCalledWith('comment_post_mark_seen', { p_post: ID })
  })

  it('is a 404 for a post the caller cannot see (the function returns nothing)', async () => {
    h.rpc.mockResolvedValue({ data: null, error: null })
    expect((await post()).status).toBe(404)
  })

  it('does not call the database for something that is not an id', async () => {
    expect((await post('not-a-uuid')).status).toBe(404)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('hides a database error behind a generic message', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: 'secret detail' } })
    const res = await post()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret')
  })

  it('answers a signed-out caller through the shared error handler', async () => {
    h.getCurrentAccount.mockRejectedValue(new Error('no session'))
    expect((await post()).status).toBe(401)
    expect(h.rpc).not.toHaveBeenCalled()
  })
})
