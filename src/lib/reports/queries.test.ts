import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  loadConversationsReport,
  loadResponsesReport,
  loadResolutionsReport,
  loadMessagesReport,
  loadContactsReport,
  loadAssignmentsReport,
  loadLeaderboardReport,
  loadUsersReport,
  loadLifecycleReport,
  loadBroadcastsReport,
  loadTicketsReport,
} from './queries'
import type { DateRange } from './date-utils'

/**
 * Minimal fake Supabase client: each table gets a static row set.
 * `.eq()/.gte()/.lt()` are no-op filters (the real date-range filtering
 * is asserted by feeding each test only the rows it wants counted,
 * split across the current/previous period boundary by hand) — but
 * `.not(col, 'is', null)` genuinely filters, since the real queries
 * rely on it to exclude open conversations from the closed_at/
 * resolutions queries, and a no-op there would let `undefined`/`null`
 * fields reach `localDayKey` and throw. This mirrors the fake-DB
 * pattern already used in send-message.test.ts / engine.test.ts.
 */
function fakeDb(tables: Record<string, unknown[]>): SupabaseClient {
  return {
    from(table: string) {
      let rows = tables[table] ?? []
      const builder = {
        select: () => builder,
        eq: () => builder,
        gte: () => builder,
        lt: () => builder,
        // Only `.not(column, 'is', null)` is used by the real queries,
        // so that's the only shape this fake implements.
        not: (column: string) => {
          rows = rows.filter((r) => (r as Record<string, unknown>)[column] != null)
          return builder
        },
        // No-op filters, same reasoning as `.eq()`/`.gte()`/`.lt()` above —
        // loadTicketsReport's two `tickets` queries (opened vs resolved)
        // both get the full fixture; the precise resolved-vs-not split is
        // asserted via each test's fixture composition, not via these.
        in: () => builder,
        or: () => builder,
        order: () => builder,
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) =>
          resolve({ data: rows, error: null }),
      }
      return builder
    },
  } as unknown as SupabaseClient
}

// A 3-day current period, and a 3-day previous period immediately
// before it — small enough to hand-place rows on either side.
const RANGE: DateRange = { from: new Date('2026-09-15T00:00:00'), to: new Date('2026-09-17T00:00:00') }
const PREV_DAY = '2026-09-12T10:00:00' // inside the previous 3-day period
const CUR_DAY_1 = '2026-09-15T10:00:00'
const CUR_DAY_2 = '2026-09-16T10:00:00'

describe('loadConversationsReport', () => {
  it('splits opened counts across current vs previous period', async () => {
    // The implementation queries `conversations` twice (once by
    // created_at for "opened", once by closed_at for "closed") — this
    // fake DB hands both queries the same fixture rows regardless, so
    // this test only asserts on `opened` (rows here have no closed_at,
    // which the closed-side query harmlessly finds nothing to bucket).
    const db = fakeDb({
      conversations: [
        { created_at: CUR_DAY_1 },
        { created_at: CUR_DAY_2 },
        { created_at: PREV_DAY },
      ],
    })

    const report = await loadConversationsReport(db, 'acct-1', RANGE)
    expect(report.opened.current).toBe(2)
    expect(report.opened.previous).toBe(1)
    expect(report.opened.percentChange).toBe(100)
  })

  it('reports null percentChange when the previous period had zero activity', async () => {
    const db = fakeDb({ conversations: [{ created_at: CUR_DAY_1, closed_at: null }] })
    const report = await loadConversationsReport(db, 'acct-1', RANGE)
    expect(report.opened.previous).toBe(0)
    expect(report.opened.current).toBe(1)
    expect(report.opened.percentChange).toBeNull()
  })

  it('seeds every day in range with a zero-value bucket', async () => {
    const db = fakeDb({ conversations: [] })
    const report = await loadConversationsReport(db, 'acct-1', RANGE)
    expect(report.series).toEqual([
      { day: '2026-09-15', opened: 0, closed: 0 },
      { day: '2026-09-16', opened: 0, closed: 0 },
      { day: '2026-09-17', opened: 0, closed: 0 },
    ])
  })
})

describe('loadResponsesReport', () => {
  it('pairs an unanswered customer message with the next outbound reply', async () => {
    const db = fakeDb({
      messages: [
        { conversation_id: 'c1', sender_type: 'customer', created_at: '2026-09-15T10:00:00' },
        { conversation_id: 'c1', sender_type: 'agent', created_at: '2026-09-15T10:05:00' },
      ],
    })
    const report = await loadResponsesReport(db, 'acct-1', RANGE)
    expect(report.avgMinutes.current).toBe(5)
    expect(report.series.find((s) => s.day === '2026-09-15')?.avgMinutes).toBe(5)
  })

  it('only counts the FIRST unanswered customer message once, not every double-text', async () => {
    const db = fakeDb({
      messages: [
        { conversation_id: 'c1', sender_type: 'customer', created_at: '2026-09-15T10:00:00' },
        { conversation_id: 'c1', sender_type: 'customer', created_at: '2026-09-15T10:02:00' },
        { conversation_id: 'c1', sender_type: 'agent', created_at: '2026-09-15T10:10:00' },
      ],
    })
    const report = await loadResponsesReport(db, 'acct-1', RANGE)
    // Measured from the FIRST customer message (10:00), not the second.
    expect(report.avgMinutes.current).toBe(10)
  })

  it('returns 0/null-safe values when there are no samples at all', async () => {
    const db = fakeDb({ messages: [] })
    const report = await loadResponsesReport(db, 'acct-1', RANGE)
    expect(report.avgMinutes.current).toBe(0)
    expect(report.series.every((s) => s.avgMinutes === null)).toBe(true)
  })
})

describe('loadResolutionsReport', () => {
  it('computes open→closed duration in minutes, bucketed by closed_at day', async () => {
    const db = fakeDb({
      conversations: [
        { created_at: '2026-09-15T09:00:00', closed_at: '2026-09-15T10:30:00' },
      ],
    })
    const report = await loadResolutionsReport(db, 'acct-1', RANGE)
    expect(report.avgMinutes.current).toBe(90)
    expect(report.series.find((s) => s.day === '2026-09-15')?.avgMinutes).toBe(90)
  })

  it('ignores a negative duration (clock skew / bad data) rather than corrupting the average', async () => {
    const db = fakeDb({
      conversations: [
        { created_at: '2026-09-15T10:30:00', closed_at: '2026-09-15T09:00:00' },
      ],
    })
    const report = await loadResolutionsReport(db, 'acct-1', RANGE)
    expect(report.avgMinutes.current).toBe(0)
  })
})

describe('loadMessagesReport', () => {
  it('splits customer (incoming) from agent/bot (outgoing) volume', async () => {
    const db = fakeDb({
      messages: [
        { created_at: CUR_DAY_1, sender_type: 'customer' },
        { created_at: CUR_DAY_1, sender_type: 'agent' },
        { created_at: CUR_DAY_1, sender_type: 'bot' },
      ],
    })
    const report = await loadMessagesReport(db, 'acct-1', RANGE)
    expect(report.incoming.current).toBe(1)
    expect(report.outgoing.current).toBe(2) // agent + bot both count as outgoing
  })
})

describe('loadContactsReport', () => {
  it('counts new contacts per day and totals the period', async () => {
    const db = fakeDb({
      contacts: [{ created_at: CUR_DAY_1 }, { created_at: CUR_DAY_2 }],
    })
    const report = await loadContactsReport(db, 'acct-1', RANGE)
    expect(report.newContacts.current).toBe(2)
    expect(report.series.find((s) => s.day === '2026-09-15')?.value).toBe(1)
  })
})

describe('loadAssignmentsReport', () => {
  it('distributes conversations across agents and teams, with an Unassigned bucket', async () => {
    const db = fakeDb({
      conversations: [
        { assigned_agent_id: 'u1', assigned_team_id: 't1' },
        { assigned_agent_id: 'u1', assigned_team_id: 't1' },
        { assigned_agent_id: null, assigned_team_id: null },
      ],
      profiles: [{ user_id: 'u1', full_name: 'Alice' }],
      teams: [{ id: 't1', name: 'Payments' }],
    })
    const report = await loadAssignmentsReport(db, 'acct-1', RANGE)
    expect(report.totalConversations).toBe(3)
    expect(report.byAgent).toEqual([
      { id: 'u1', name: 'Alice', count: 2 },
      { id: null, name: 'Unassigned', count: 1 },
    ])
    expect(report.byTeam).toEqual([
      { id: 't1', name: 'Payments', count: 2 },
      { id: null, name: 'No team', count: 1 },
    ])
  })
})

describe('loadLeaderboardReport / loadUsersReport', () => {
  const profiles = [
    { user_id: 'u1', full_name: 'Alice', email: 'alice@x.com', created_at: '2026-01-01T00:00:00' },
    { user_id: 'u2', full_name: 'Bob', email: 'bob@x.com', created_at: '2026-02-01T00:00:00' },
  ]
  const messages = [
    // u1 answers a customer wait in 5 minutes.
    { conversation_id: 'c1', sender_type: 'customer', sender_id: null, created_at: '2026-09-15T10:00:00' },
    { conversation_id: 'c1', sender_type: 'agent', sender_id: 'u1', created_at: '2026-09-15T10:05:00' },
    // u2 sends a second message with no pending customer wait — counts
    // toward volume but not toward response time.
    { conversation_id: 'c1', sender_type: 'agent', sender_id: 'u2', created_at: '2026-09-15T10:06:00' },
    // A bot reply clears a wait but isn't attributable to any agent.
    { conversation_id: 'c2', sender_type: 'customer', sender_id: null, created_at: '2026-09-15T11:00:00' },
    { conversation_id: 'c2', sender_type: 'bot', sender_id: null, created_at: '2026-09-15T11:01:00' },
  ]
  const conversations = [
    { assigned_agent_id: 'u1', created_at: CUR_DAY_1, closed_at: CUR_DAY_2 },
    { assigned_agent_id: 'u1', created_at: CUR_DAY_1, closed_at: null },
  ]

  it('ranks agents by message volume, tie-broken by conversations closed', async () => {
    const db = fakeDb({ profiles, messages, conversations })
    const report = await loadLeaderboardReport(db, 'acct-1', RANGE)
    expect(report.entries.map((e) => e.fullName)).toEqual(['Alice', 'Bob'])
    expect(report.entries[0]).toMatchObject({
      rank: 1,
      messagesSent: 1,
      conversationsAssigned: 2,
      conversationsClosed: 1,
      avgResponseMinutes: 5,
    })
    expect(report.entries[1]).toMatchObject({
      rank: 2,
      messagesSent: 1,
      conversationsAssigned: 0,
      avgResponseMinutes: null,
    })
  })

  it('lists every account member alphabetically, including zero-activity ones', async () => {
    const db = fakeDb({ profiles, messages: [], conversations: [] })
    const report = await loadUsersReport(db, 'acct-1', RANGE)
    expect(report.users.map((u) => u.fullName)).toEqual(['Alice', 'Bob'])
    expect(report.users[0].memberSince).toBe('2026-01-01T00:00:00')
    expect(report.users.every((u) => u.messagesSent === 0)).toBe(true)
  })
})

describe('loadLifecycleReport', () => {
  it('snapshots the current distribution and this-period moves separately', async () => {
    const db = fakeDb({
      contacts: [
        { lifecycle_stage: 'lead', lifecycle_stage_changed_at: null },
        { lifecycle_stage: 'active', lifecycle_stage_changed_at: '2026-09-15T10:00:00' },
        { lifecycle_stage: 'customer', lifecycle_stage_changed_at: '2026-09-15T11:00:00' },
      ],
    })
    const report = await loadLifecycleReport(db, 'acct-1', RANGE)
    expect(report.distribution).toEqual({ lead: 1, active: 1, customer: 1, churned: 0 })
    // Only the two rows with a non-null lifecycle_stage_changed_at
    // survive the fake DB's `.not(...)` filter.
    expect(report.movedIn).toEqual({ lead: 0, active: 1, customer: 1, churned: 0 })
  })
})

describe('loadBroadcastsReport', () => {
  it('sums recipients/delivered/read/failed and computes rates', async () => {
    const db = fakeDb({
      broadcasts: [
        {
          created_at: CUR_DAY_1,
          total_recipients: 100,
          sent_count: 100,
          delivered_count: 90,
          read_count: 50,
          failed_count: 10,
        },
      ],
    })
    const report = await loadBroadcastsReport(db, 'acct-1', RANGE)
    expect(report.broadcastsSent.current).toBe(1)
    expect(report.totalRecipients.current).toBe(100)
    expect(report.deliveredRate).toBe(90)
    expect(report.readRate).toBe(50)
    expect(report.failedRate).toBe(10)
  })

  it('reports null rates when nothing was sent in range', async () => {
    const db = fakeDb({ broadcasts: [] })
    const report = await loadBroadcastsReport(db, 'acct-1', RANGE)
    expect(report.deliveredRate).toBeNull()
    expect(report.readRate).toBeNull()
    expect(report.failedRate).toBeNull()
  })
})

describe('loadTicketsReport', () => {
  it('counts opened tickets separately from resolved ones, and computes avg resolution time per agent', async () => {
    const db = fakeDb({
      tickets: [
        // Opened this period, still open — counts toward `opened` only.
        { created_at: CUR_DAY_1, resolved_at: null, closed_at: null, assigned_agent_id: null, status: 'open' },
        // Opened AND resolved this period, 24h turnaround, assigned to u1.
        {
          created_at: CUR_DAY_1,
          resolved_at: CUR_DAY_2,
          closed_at: null,
          assigned_agent_id: 'u1',
          status: 'resolved',
        },
        // Opened in the previous period — counts toward `opened.previous`.
        { created_at: PREV_DAY, resolved_at: null, closed_at: null, assigned_agent_id: null, status: 'open' },
      ],
      profiles: [{ user_id: 'u1', full_name: 'Alice' }],
    })

    const report = await loadTicketsReport(db, 'acct-1', RANGE)
    expect(report.opened.current).toBe(2)
    expect(report.opened.previous).toBe(1)
    expect(report.resolved.current).toBe(1)
    expect(report.avgResolutionMinutes.current).toBe(24 * 60)
    expect(report.byAgent).toEqual([
      { userId: 'u1', fullName: 'Alice', ticketsResolved: 1, avgResolutionMinutes: 24 * 60 },
    ])
  })

  it('falls back to closed_at when resolved_at is null, and excludes agents with nothing resolved', async () => {
    const db = fakeDb({
      tickets: [
        {
          created_at: '2026-09-15T09:00:00',
          resolved_at: null,
          closed_at: '2026-09-15T10:30:00',
          assigned_agent_id: 'u2',
          status: 'closed',
        },
      ],
      profiles: [
        { user_id: 'u1', full_name: 'Alice' },
        { user_id: 'u2', full_name: 'Bob' },
      ],
    })

    const report = await loadTicketsReport(db, 'acct-1', RANGE)
    expect(report.resolved.current).toBe(1)
    expect(report.avgResolutionMinutes.current).toBe(90)
    expect(report.byAgent).toEqual([
      { userId: 'u2', fullName: 'Bob', ticketsResolved: 1, avgResolutionMinutes: 90 },
    ])
  })
})
