import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ getCurrentAccount: vi.fn(), rpc: vi.fn() }))

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: h.getCurrentAccount,
  toErrorResponse: () => Response.json({ error: 'auth failed' }, { status: 401 }),
}))

import { GET } from './route'

const get = (qs = '') => GET(new Request(`http://localhost/api/comments/posts${qs}`))

beforeEach(() => {
  h.getCurrentAccount.mockReset()
  h.rpc.mockReset()
  h.getCurrentAccount.mockResolvedValue({ supabase: { rpc: h.rpc }, accountId: 'a1', userId: 'u1' })
  h.rpc.mockResolvedValue({ data: [], error: null })
})

describe('GET /api/comments/posts', () => {
  it('asks the database function for the caller\'s workspace, defaulting to To do', async () => {
    await get()
    expect(h.rpc).toHaveBeenCalledWith('comment_posts_inbox', {
      p_account: 'a1',
      p_provider: null,
      p_filter: 'open',
      p_search: null,
      p_limit: 41,
      p_offset: 0,
    })
  })

  it('passes the view, provider, search and offset through', async () => {
    await get('?view=done&provider=tiktok&q=%20giveaway%20&offset=40')
    expect(h.rpc).toHaveBeenCalledWith('comment_posts_inbox', {
      p_account: 'a1',
      p_provider: 'tiktok',
      p_filter: 'done',
      p_search: 'giveaway',
      p_limit: 41,
      p_offset: 40,
    })
  })

  it('rejects an unknown view or provider before touching the database', async () => {
    expect((await get('?view=everything')).status).toBe(400)
    expect((await get('?provider=myspace')).status).toBe(400)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('treats a bad offset as the first page', async () => {
    await get('?offset=-5')
    expect(h.rpc.mock.calls[0][1].p_offset).toBe(0)
    await get('?offset=abc')
    expect(h.rpc.mock.calls[1][1].p_offset).toBe(0)
  })

  it('returns a page of 40 posts and says whether there are more', async () => {
    const rows = Array.from({ length: 41 }, (_, i) => ({ post_id: `p${i}` }))
    h.rpc.mockResolvedValue({ data: rows, error: null })
    const body = await (await get()).json()
    expect(body.posts).toHaveLength(40)
    expect(body.has_more).toBe(true)
    h.rpc.mockResolvedValue({ data: rows.slice(0, 3), error: null })
    const last = await (await get()).json()
    expect(last.posts).toHaveLength(3)
    expect(last.has_more).toBe(false)
  })

  it('hides a database error behind a generic message', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: 'relation "secret" does not exist' } })
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret')
  })

  it('answers a signed-out caller through the shared error handler', async () => {
    h.getCurrentAccount.mockRejectedValue(new Error('no session'))
    expect((await get()).status).toBe(401)
  })
})
