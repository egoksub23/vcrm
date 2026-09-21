import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fail, fakeSupabase, ok, type FakeCall } from '@/lib/testing/fake-supabase'

const h = vi.hoisted(() => ({ seers: vi.fn() }))
vi.mock('@/lib/auth/capability-recipients', () => ({
  loadCapabilityRecipients: h.seers,
}))

import { TicketCommentError, postTicketComment } from './comment-write'

const ACCOUNT = 'acct-1'
const TICKET = 'tick-1'
const AUTHOR = 'author'

const input = (over: Partial<Parameters<typeof postTicketComment>[2]> = {}) => ({
  accountId: ACCOUNT,
  userId: AUTHOR,
  ticketId: TICKET,
  body: 'Please look @Ada and @Support',
  mentions: [] as string[],
  teams: [] as string[],
  kind: 'response' as const,
  ...over,
})

function setup(
  opts: {
    ticket?: unknown
    insertError?: { message: string; code?: string }
    watchersFail?: boolean
    mentionsFail?: boolean
  } = {},
) {
  const user = fakeSupabase({
    tickets: () => ok('ticket' in opts ? opts.ticket : { id: TICKET, account_id: ACCOUNT, status: 'open' }),
    ticket_comments: (call: FakeCall) =>
      opts.insertError
        ? { data: null, error: opts.insertError }
        : ok({ id: 'c1', ...(call.payload as object), created_at: '2026-09-21T10:00:00Z' }),
  })
  const admin = fakeSupabase({
    profiles: () => ok([{ user_id: AUTHOR }, { user_id: 'ada' }, { user_id: 'bo' }, { user_id: 'cy' }]),
    // Like the database, only teams that exist and were asked for.
    teams: (call: FakeCall) => ok(inIds(call).filter((id) => id === 'support').map((id) => ({ id }))),
    team_members: () => ok([
      { team_id: 'support', user_id: 'bo' },
      { team_id: 'support', user_id: 'cy' },
      { team_id: 'support', user_id: AUTHOR },
    ]),
    ticket_watchers: () => (opts.watchersFail ? fail('nope') : ok(null)),
    ticket_mentions: () => (opts.mentionsFail ? fail('nope') : ok(null)),
  })
  return { user, admin, run: (over = {}) => postTicketComment(user.client, admin.client, input(over)) }
}

const inIds = (call: FakeCall): string[] =>
  (call.filters.find((f) => f.kind === 'in')?.value as string[] | undefined) ?? []

const callOf = (s: ReturnType<typeof fakeSupabase>, table: string, op: FakeCall['op']) =>
  s.calls.find((c) => c.table === table && c.op === op)

beforeEach(() => {
  h.seers.mockReset()
  h.seers.mockResolvedValue([AUTHOR, 'ada', 'bo', 'cy'])
})

describe('postTicketComment: validation', () => {
  it('rejects an empty comment and one that is too long', async () => {
    const s = setup()
    await expect(s.run({ body: '   ' })).rejects.toMatchObject({ status: 400 })
    await expect(s.run({ body: 'x'.repeat(10001) })).rejects.toMatchObject({ status: 400 })
    expect(s.user.calls).toHaveLength(0)
  })

  it('says not found for a ticket the caller cannot read or one from another account', async () => {
    await expect(setup({ ticket: null }).run()).rejects.toMatchObject({ status: 404 })
    await expect(setup({ ticket: { id: TICKET, account_id: 'other', status: 'open' } }).run()).rejects.toBeInstanceOf(
      TicketCommentError,
    )
  })

  it('maps a permission refusal from the database to 403', async () => {
    const s = setup({ insertError: { message: 'denied', code: '42501' } })
    await expect(s.run()).rejects.toMatchObject({ status: 403 })
  })
})

describe('postTicketComment: people and teams', () => {
  it('a plain comment writes only the comment, with no follow-ups', async () => {
    const s = setup()
    const res = await s.run({ body: 'Just a note' })
    expect(res.reached).toBe(0)
    expect(res.requestsCreated).toBe(0)
    expect(s.admin.calls).toHaveLength(0)
    const payload = callOf(s.user, 'ticket_comments', 'insert')?.payload as Record<string, unknown>
    expect(payload).toMatchObject({ author_id: AUTHOR, account_id: ACCOUNT, mentions: [], mention_teams: [] })
  })

  it('a team expands to its members (not the author): comment, watchers and requests', async () => {
    const s = setup()
    const res = await s.run({ teams: ['support'] })
    expect(res.reached).toBe(2)
    expect(res.requestsCreated).toBe(2)

    const comment = callOf(s.user, 'ticket_comments', 'insert')?.payload as { mentions: string[]; mention_teams: string[] }
    expect(comment.mentions.sort()).toEqual(['bo', 'cy'])
    expect(comment.mention_teams).toEqual(['support'])

    const watchers = callOf(s.admin, 'ticket_watchers', 'upsert')
    expect((watchers?.payload as { user_id: string }[]).map((w) => w.user_id).sort()).toEqual(['bo', 'cy'])
    expect(watchers?.options).toMatchObject({ onConflict: 'ticket_id,user_id', ignoreDuplicates: true })

    const requests = callOf(s.admin, 'ticket_mentions', 'insert')?.payload as Record<string, unknown>[]
    expect(requests).toHaveLength(2)
    expect(requests.every((r) => r.via_team_id === 'support' && r.kind === 'response' && r.comment_id === 'c1')).toBe(true)
    expect(requests.every((r) => r.requested_by === AUTHOR && r.account_id === ACCOUNT && r.ticket_id === TICKET)).toBe(true)
  })

  it('a direct mention has no team on its request', async () => {
    const s = setup()
    await s.run({ mentions: ['ada'] })
    const requests = callOf(s.admin, 'ticket_mentions', 'insert')?.payload as Record<string, unknown>[]
    expect(requests).toEqual([expect.objectContaining({ mentioned_user_id: 'ada', via_team_id: null })])
  })

  it('FYI only mentions people and follows them but records no request', async () => {
    const s = setup()
    const res = await s.run({ mentions: ['ada'], kind: 'fyi' })
    expect(res.reached).toBe(1)
    expect(res.requestsCreated).toBe(0)
    expect(callOf(s.admin, 'ticket_watchers', 'upsert')).toBeDefined()
    expect(callOf(s.admin, 'ticket_mentions', 'insert')).toBeUndefined()
  })

  it('skips members who cannot open tickets and tells the author how many', async () => {
    h.seers.mockResolvedValue([AUTHOR, 'ada'])
    const s = setup()
    const res = await s.run({ mentions: ['ada'], teams: ['support'] })
    expect(res.reached).toBe(1)
    expect(res.skippedNoAccess).toBe(2)
    expect(h.seers).toHaveBeenCalledWith(expect.anything(), ACCOUNT, 'menu.tickets')
  })

  it('ignores an unknown team id and a person from another account', async () => {
    const s = setup()
    const res = await s.run({ mentions: ['stranger'], teams: ['ghost'] })
    expect(res.reached).toBe(0)
    const comment = callOf(s.user, 'ticket_comments', 'insert')?.payload as { mention_teams: string[] }
    expect(comment.mention_teams).toEqual([])
  })
})

describe('postTicketComment: things that go wrong after the comment', () => {
  it('a failed request write is reported, the comment stays', async () => {
    const res = await setup({ mentionsFail: true }).run({ mentions: ['ada'] })
    expect(res.comment.id).toBe('c1')
    expect(res.requestsCreated).toBe(0)
    expect(res.warnings).toContain('requests_failed')
  })

  it('a failed watcher write is reported, the requests still go through', async () => {
    const res = await setup({ watchersFail: true }).run({ mentions: ['ada'] })
    expect(res.warnings).toContain('watchers_failed')
    expect(res.requestsCreated).toBe(1)
  })

  it('records no request on a ticket that is already resolved or closed', async () => {
    for (const status of ['resolved', 'closed']) {
      const s = setup({ ticket: { id: TICKET, account_id: ACCOUNT, status } })
      const res = await s.run({ mentions: ['ada'] })
      expect(res.requestsCreated).toBe(0)
      expect(res.warnings).toContain('ticket_closed')
      expect(callOf(s.admin, 'ticket_mentions', 'insert')).toBeUndefined()
    }
  })
})
