import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  getCurrentAccount: vi.fn(),
  postTicketComment: vi.fn(),
  resolveMention: vi.fn(),
}))

class Denied extends Error {
  readonly status = 403
}

vi.mock('@/lib/auth/account', () => ({
  requireCapability: h.requireCapability,
  getCurrentAccount: h.getCurrentAccount,
  toErrorResponse: (e: unknown) =>
    e instanceof Denied ? Response.json({ error: e.message }, { status: 403 }) : Response.json({ error: 'boom' }, { status: 500 }),
}))
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({ admin: true }) }))
vi.mock('@/lib/tickets/comment-write', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tickets/comment-write')>('@/lib/tickets/comment-write')
  return { ...actual, postTicketComment: h.postTicketComment }
})
vi.mock('@/lib/tickets/mention-resolve', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tickets/mention-resolve')>('@/lib/tickets/mention-resolve')
  return { ...actual, resolveMention: h.resolveMention }
})

import { TicketCommentError } from '@/lib/tickets/comment-write'
import { POST } from './[id]/comments/route'
import { PATCH } from './[id]/mentions/[mentionId]/route'

const ctx = { supabase: { user: true }, userId: 'u1', accountId: 'a1' }

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/tickets/t1/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 't1' }) },
  )

const patch = (body: unknown) =>
  PATCH(
    new Request('http://localhost/api/tickets/t1/mentions/m1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 't1', mentionId: 'm1' }) },
  )

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset()
})

describe('POST /api/tickets/[id]/comments', () => {
  it('needs the tickets.work capability, and a refusal reaches the caller', async () => {
    h.requireCapability.mockRejectedValue(new Denied("This action requires the 'tickets.work' permission"))
    const res = await post({ body: 'hi' })
    expect(res.status).toBe(403)
    expect(h.requireCapability).toHaveBeenCalledWith('tickets.work')
    expect(h.postTicketComment).not.toHaveBeenCalled()
  })

  it('passes the caller, the people, the teams and the kind to the writer', async () => {
    h.requireCapability.mockResolvedValue(ctx)
    h.postTicketComment.mockResolvedValue({ comment: { id: 'c1' }, reached: 2 })
    const res = await post({ body: 'hi @Team', mentions: ['u2', 5], teams: ['t9'], kind: 'fyi' })
    expect(res.status).toBe(201)
    expect(h.postTicketComment).toHaveBeenCalledWith(ctx.supabase, { admin: true }, {
      accountId: 'a1',
      userId: 'u1',
      ticketId: 't1',
      body: 'hi @Team',
      mentions: ['u2', 5],
      teams: ['t9'],
      kind: 'fyi',
    })
  })

  it('defaults to a request for a response and tolerates a broken body', async () => {
    h.requireCapability.mockResolvedValue(ctx)
    h.postTicketComment.mockResolvedValue({ comment: { id: 'c1' } })
    await post('not json')
    expect(h.postTicketComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ body: '', mentions: [], teams: [], kind: 'response' }),
    )
  })

  it('turns a writer error into its status and message', async () => {
    h.requireCapability.mockResolvedValue(ctx)
    h.postTicketComment.mockRejectedValue(new TicketCommentError('Ticket not found.', 404))
    const res = await post({ body: 'hi' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Ticket not found.' })
  })
})

describe('PATCH /api/tickets/[id]/mentions/[mentionId]', () => {
  it('rejects an unknown action before checking anything', async () => {
    const res = await patch({ action: 'delete' })
    expect(res.status).toBe(400)
    expect(h.requireCapability).not.toHaveBeenCalled()
    expect(h.getCurrentAccount).not.toHaveBeenCalled()
  })

  it('Mark as done needs only a signed-in member (no tickets.work)', async () => {
    h.getCurrentAccount.mockResolvedValue(ctx)
    h.resolveMention.mockResolvedValue({ id: 'm1', status: 'done' })
    const res = await patch({ action: 'done' })
    expect(res.status).toBe(200)
    expect(h.requireCapability).not.toHaveBeenCalled()
    expect(h.resolveMention).toHaveBeenCalledWith(ctx.supabase, { admin: true }, {
      ticketId: 't1',
      mentionId: 'm1',
      userId: 'u1',
      action: 'done',
    })
  })

  it('Cancel request and Nudge need tickets.work', async () => {
    for (const action of ['cancel', 'nudge']) {
      h.requireCapability.mockReset()
      h.requireCapability.mockRejectedValue(new Denied('no'))
      const res = await patch({ action })
      expect(res.status).toBe(403)
      expect(h.requireCapability).toHaveBeenCalledWith('tickets.work')
      expect(h.resolveMention).not.toHaveBeenCalled()
    }
  })

  it('passes the rule errors of the resolver through (not the asked person, already closed, too soon)', async () => {
    h.requireCapability.mockResolvedValue(ctx)
    for (const status of [403, 409, 429] as const) {
      h.resolveMention.mockRejectedValueOnce(new TicketCommentError('nope', status))
      const res = await patch({ action: 'nudge' })
      expect(res.status).toBe(status)
    }
  })
})
