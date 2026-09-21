import { describe, expect, it } from 'vitest'

import { fail, fakeSupabase, ok, type FakeCall } from '@/lib/testing/fake-supabase'
import type { TicketMention } from '@/types'

import {
  NUDGE_COOLDOWN_MS,
  isMentionAction,
  nudgeWaitMs,
  resolveMention,
  type MentionAction,
} from './mention-resolve'

const NOW = new Date('2026-09-21T12:00:00Z')

const mention = (over: Partial<TicketMention> = {}): TicketMention => ({
  id: 'm1',
  account_id: 'a',
  ticket_id: 't1',
  comment_id: 'c1',
  mentioned_user_id: 'asked',
  requested_by: 'asker',
  via_team_id: null,
  kind: 'response',
  status: 'open',
  created_at: '2026-09-21T09:00:00Z',
  resolved_at: null,
  resolved_by: null,
  resolved_reason: null,
  nudged_at: null,
  ...over,
})

function setup(row: TicketMention | null, opts: { claimLost?: boolean } = {}) {
  const user = fakeSupabase({ ticket_mentions: () => ok(row) })
  const admin = fakeSupabase({
    ticket_mentions: (call: FakeCall) => {
      if (call.op === 'update' && opts.claimLost) return ok(null)
      return ok({ ...(row as object), ...(call.payload as object) })
    },
    tickets: () => ok({ account_id: 'a', ticket_number: 12, subject: 'Refund', contact_id: 'ct' }),
    profiles: () => ok({ full_name: 'Ada' }),
    notifications: () => ok(null),
  })
  const run = (userId: string, action: MentionAction) =>
    resolveMention(user.client, admin.client, { ticketId: 't1', mentionId: 'm1', userId, action, now: NOW })
  return { user, admin, run }
}

const update = (s: ReturnType<typeof setup>) => s.admin.calls.find((c) => c.table === 'ticket_mentions' && c.op === 'update')

describe('isMentionAction', () => {
  it('accepts only the three actions', () => {
    expect(['done', 'cancel', 'nudge'].every(isMentionAction)).toBe(true)
    expect(isMentionAction('delete')).toBe(false)
    expect(isMentionAction(undefined)).toBe(false)
  })
})

describe('mark as done', () => {
  it('lets the person asked close their own open request', async () => {
    const s = setup(mention())
    const res = await s.run('asked', 'done')
    expect(res.status).toBe('done')
    expect(update(s)?.payload).toMatchObject({ status: 'done', resolved_by: 'asked', resolved_reason: 'marked_done' })
    // Only an open row can be closed: the write is conditional.
    expect(update(s)?.filters).toContainEqual({ kind: 'eq', column: 'status', value: 'open' })
  })

  it('refuses anyone else, the requester included', async () => {
    for (const who of ['asker', 'stranger']) {
      const s = setup(mention())
      await expect(s.run(who, 'done')).rejects.toMatchObject({ status: 403 })
      expect(update(s)).toBeUndefined()
    }
  })

  it('is not an error when it is already done (a double click, or the reply got there first)', async () => {
    const s = setup(mention({ status: 'done', resolved_reason: 'replied', resolved_at: 'x' }))
    const res = await s.run('asked', 'done')
    expect(res.status).toBe('done')
    expect(update(s)).toBeUndefined()
  })

  it('cannot close a cancelled request', async () => {
    const s = setup(mention({ status: 'cancelled', resolved_reason: 'cancelled', resolved_at: 'x' }))
    await expect(s.run('asked', 'done')).rejects.toMatchObject({ status: 409 })
  })

  it('says so when someone closed it between the read and the write', async () => {
    const s = setup(mention(), { claimLost: true })
    await expect(s.run('asked', 'done')).rejects.toMatchObject({ status: 409 })
  })
})

describe('cancel request', () => {
  it('lets the requester withdraw an open request', async () => {
    const s = setup(mention())
    const res = await s.run('asker', 'cancel')
    expect(res.status).toBe('cancelled')
    expect(update(s)?.payload).toMatchObject({ status: 'cancelled', resolved_by: 'asker', resolved_reason: 'cancelled' })
  })

  it('refuses the person asked and strangers', async () => {
    for (const who of ['asked', 'stranger']) {
      await expect(setup(mention()).run(who, 'cancel')).rejects.toMatchObject({ status: 403 })
    }
  })

  it('cannot cancel what is already closed', async () => {
    const s = setup(mention({ status: 'done', resolved_reason: 'replied', resolved_at: 'x' }))
    await expect(s.run('asker', 'cancel')).rejects.toMatchObject({ status: 409 })
  })
})

describe('nudge', () => {
  it('sends the person asked a reminder that links to the comment, and stamps the request', async () => {
    const s = setup(mention())
    await s.run('asker', 'nudge')
    expect(update(s)?.payload).toEqual({ nudged_at: NOW.toISOString() })
    const note = s.admin.calls.find((c) => c.table === 'notifications' && c.op === 'insert')?.payload as Record<string, unknown>
    expect(note).toMatchObject({
      user_id: 'asked',
      type: 'ticket_mention',
      ticket_id: 't1',
      comment_id: 'c1',
      actor_user_id: 'asker',
    })
    expect(String(note.body)).toContain('Ada')
    expect(String(note.body)).toContain('#12')
  })

  it('only the requester can nudge', async () => {
    await expect(setup(mention()).run('asked', 'nudge')).rejects.toMatchObject({ status: 403 })
  })

  it('waits an hour between nudges', async () => {
    const recent = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString()
    const s = setup(mention({ nudged_at: recent }))
    await expect(s.run('asker', 'nudge')).rejects.toMatchObject({ status: 429 })
    expect(s.admin.calls.find((c) => c.table === 'notifications')).toBeUndefined()

    const old = new Date(NOW.getTime() - NUDGE_COOLDOWN_MS - 1000).toISOString()
    await expect(setup(mention({ nudged_at: old })).run('asker', 'nudge')).resolves.toBeDefined()
  })

  it('two quick clicks send one reminder: the loser of the claim sends nothing', async () => {
    const s = setup(mention(), { claimLost: true })
    await expect(s.run('asker', 'nudge')).rejects.toMatchObject({ status: 429 })
    expect(s.admin.calls.find((c) => c.table === 'notifications')).toBeUndefined()
  })
})

describe('reading the request', () => {
  it('a request the caller cannot see (RLS) is not found', async () => {
    await expect(setup(null).run('asked', 'done')).rejects.toMatchObject({ status: 404 })
  })

  it('a failed read is a server error, not a leak', async () => {
    const user = fakeSupabase({ ticket_mentions: () => fail('db down') })
    const admin = fakeSupabase({})
    await expect(
      resolveMention(user.client, admin.client, { ticketId: 't', mentionId: 'm', userId: 'u', action: 'done' }),
    ).rejects.toMatchObject({ status: 500 })
  })
})

describe('nudgeWaitMs', () => {
  it('is zero when never nudged or long ago, and the time left otherwise', () => {
    expect(nudgeWaitMs(null, NOW)).toBe(0)
    expect(nudgeWaitMs(new Date(NOW.getTime() - 2 * NUDGE_COOLDOWN_MS).toISOString(), NOW)).toBe(0)
    expect(nudgeWaitMs(new Date(NOW.getTime() - NUDGE_COOLDOWN_MS + 5000).toISOString(), NOW)).toBe(5000)
  })
})
