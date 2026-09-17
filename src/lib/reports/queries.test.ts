import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  loadConversationsReport,
  loadResponsesReport,
  loadResolutionsReport,
  loadMessagesReport,
  loadContactsReport,
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
