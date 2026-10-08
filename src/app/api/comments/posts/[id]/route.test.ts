import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ getCurrentAccount: vi.fn() }))

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: h.getCurrentAccount,
  toErrorResponse: () => Response.json({ error: 'auth failed' }, { status: 401 }),
}))

import { GET } from './route'

type Result = { data: unknown; error: unknown }

/** A supabase stand-in whose every query returns what the test set for that table, and records its filters. */
function stub(results: Record<string, Result>) {
  const calls: { table: string; eq: [string, unknown][]; order?: unknown; limit?: number }[] = []
  const from = (table: string) => {
    const rec = { table, eq: [] as [string, unknown][], order: undefined as unknown, limit: undefined as number | undefined }
    calls.push(rec)
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (rec.eq.push([c, v]), q),
      order: (...a: unknown[]) => ((rec.order = a), q),
      limit: (n: number) => ((rec.limit = n), q),
      maybeSingle: () => Promise.resolve(results[table]),
      then: (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(results[table]).then(res, rej),
    }
    return q
  }
  return { from, calls }
}

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  provider: 'instagram',
  direction: 'inbound',
  status: 'visible',
  parent_comment_id: null,
  author_external_id: 'u',
  private_replied_at: null,
  provider_created_at: '2026-10-07T10:00:00Z',
  ...over,
})
const get = () => GET(new Request('http://localhost/api/comments/posts/p1'), { params: Promise.resolve({ id: 'p1' }) })

beforeEach(() => h.getCurrentAccount.mockReset())

describe('GET /api/comments/posts/[id]', () => {
  it('returns the post, all its comments oldest first with what can be done to each, and the caller\'s last-seen time', async () => {
    // the database returns newest first (so the 500 newest are kept); the route hands them over oldest first
    const db = stub({
      comment_posts: { data: { id: 'p1', provider: 'instagram', message: 'Raya' }, error: null },
      comments: {
        data: [
          row('c3', { provider_created_at: '2026-10-07T12:00:00Z', direction: 'outbound' }),
          row('c2', { provider_created_at: '2026-10-07T11:00:00Z', parent_comment_id: 'c1' }),
          row('c1'),
        ],
        error: null,
      },
      comment_post_reads: { data: { seen_at: '2026-10-07T10:30:00Z' }, error: null },
    })
    h.getCurrentAccount.mockResolvedValue({ supabase: db, accountId: 'a1', userId: 'u1' })
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.post.id).toBe('p1')
    expect(body.comments.map((c: { id: string }) => c.id)).toEqual(['c1', 'c2', 'c3'])
    expect(body.truncated).toBe(false)
    expect(body.seen_at).toBe('2026-10-07T10:30:00Z')
    // the existing rules, per comment: Instagram does not take a reply to a reply; our own comment has no actions
    const caps = Object.fromEntries(body.comments.map((c: { id: string; capabilities: unknown }) => [c.id, c.capabilities]))
    expect(caps.c1.reply).toBe(true)
    expect(caps.c2.reply).toBe(false)
    expect(caps.c2.reasons.reply).toBe('igReplyToReply')
    expect(caps.c3.reply).toBe(false)
    // scoped to the caller's workspace
    expect(db.calls.find((c) => c.table === 'comments')?.eq).toEqual([
      ['account_id', 'a1'],
      ['post_id', 'p1'],
    ])
  })

  it('has no last-seen time for a post the caller has not opened', async () => {
    h.getCurrentAccount.mockResolvedValue({
      supabase: stub({
        comment_posts: { data: { id: 'p1' }, error: null },
        comments: { data: [], error: null },
        comment_post_reads: { data: null, error: null },
      }),
      accountId: 'a1',
    })
    expect((await (await get()).json()).seen_at).toBeNull()
  })

  it('says when older comments were left out', async () => {
    const many = Array.from({ length: 501 }, (_, i) => row(`c${i}`))
    h.getCurrentAccount.mockResolvedValue({
      supabase: stub({
        comment_posts: { data: { id: 'p1' }, error: null },
        comments: { data: many, error: null },
        comment_post_reads: { data: null, error: null },
      }),
      accountId: 'a1',
    })
    const body = await (await get()).json()
    expect(body.truncated).toBe(true)
    expect(body.comments).toHaveLength(500)
  })

  it('is a 404 for a post of another workspace (or none)', async () => {
    h.getCurrentAccount.mockResolvedValue({
      supabase: stub({ comment_posts: { data: null, error: null } }),
      accountId: 'a1',
    })
    expect((await get()).status).toBe(404)
  })

  it('fails with a generic message when the comments cannot be read', async () => {
    h.getCurrentAccount.mockResolvedValue({
      supabase: stub({
        comment_posts: { data: { id: 'p1' }, error: null },
        comments: { data: null, error: { message: 'secret detail' } },
        comment_post_reads: { data: null, error: null },
      }),
      accountId: 'a1',
    })
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret')
  })
})
