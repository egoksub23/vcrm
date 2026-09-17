import type { SupabaseClient } from '@supabase/supabase-js'
import {
  dayKeysInRange,
  exclusiveEnd,
  localDayKey,
  percentChange,
  previousPeriod,
  type DateRange,
} from './date-utils'

// ------------------------------------------------------------
// Reporting suite — client-side aggregation, same pattern (and same
// scale caveat) as src/lib/dashboard/queries.ts: RLS scopes every
// query to the signed-in user's account automatically. If a tenant's
// dataset outgrows this, the next step is SQL RPCs doing the same
// aggregation server-side — noted here rather than built speculatively
// ahead of a real need, and each loader below is a single, isolated
// query shape a future RPC could drop in behind unchanged.
// ------------------------------------------------------------

type DB = SupabaseClient

export interface OverviewMetric {
  current: number
  previous: number
  /** null when `previous` is 0 — a % change against zero has no
   *  meaningful value, and the UI should say "—" rather than "+Inf%". */
  percentChange: number | null
}

function metric(current: number, previous: number): OverviewMetric {
  return { current, previous, percentChange: percentChange(current, previous) }
}

/** Buckets a list of `{ at: string }`-shaped rows by local day across
 *  BOTH the current and previous period in one pass, returning the two
 *  day→count maps a report's overview tile and chart both need. */
function splitByPeriod(
  rows: { at: string }[],
  range: DateRange,
  prev: DateRange,
): { currentByDay: Map<string, number>; previousTotal: number } {
  const currentByDay = new Map(dayKeysInRange(range).map((d) => [d, 0]))
  let previousTotal = 0
  const prevKeys = new Set(dayKeysInRange(prev))
  for (const r of rows) {
    const key = localDayKey(r.at)
    if (currentByDay.has(key)) {
      currentByDay.set(key, (currentByDay.get(key) ?? 0) + 1)
    } else if (prevKeys.has(key)) {
      previousTotal += 1
    }
  }
  return { currentByDay, previousTotal }
}

// --- Conversations report ----------------------------------------------

export interface ConversationsReport {
  opened: OverviewMetric
  closed: OverviewMetric
  series: { day: string; opened: number; closed: number }[]
}

export async function loadConversationsReport(
  db: DB,
  accountId: string,
  range: DateRange,
): Promise<ConversationsReport> {
  const prev = previousPeriod(range)
  const spanStart = prev.from.toISOString()
  const spanEnd = exclusiveEnd(range.to).toISOString()

  const [openedRes, closedRes] = await Promise.all([
    db
      .from('conversations')
      .select('created_at')
      .eq('account_id', accountId)
      .gte('created_at', spanStart)
      .lt('created_at', spanEnd),
    db
      .from('conversations')
      .select('closed_at')
      .eq('account_id', accountId)
      .not('closed_at', 'is', null)
      .gte('closed_at', spanStart)
      .lt('closed_at', spanEnd),
  ])
  if (openedRes.error) throw openedRes.error
  if (closedRes.error) throw closedRes.error

  const opened = splitByPeriod(
    ((openedRes.data ?? []) as { created_at: string }[]).map((r) => ({ at: r.created_at })),
    range,
    prev,
  )
  const closed = splitByPeriod(
    ((closedRes.data ?? []) as { closed_at: string }[]).map((r) => ({ at: r.closed_at })),
    range,
    prev,
  )

  const days = dayKeysInRange(range)
  const openedCurrent = days.reduce((sum, d) => sum + (opened.currentByDay.get(d) ?? 0), 0)
  const closedCurrent = days.reduce((sum, d) => sum + (closed.currentByDay.get(d) ?? 0), 0)

  return {
    opened: metric(openedCurrent, opened.previousTotal),
    closed: metric(closedCurrent, closed.previousTotal),
    series: days.map((day) => ({
      day,
      opened: opened.currentByDay.get(day) ?? 0,
      closed: closed.currentByDay.get(day) ?? 0,
    })),
  }
}

// --- Responses report (first-response time) -----------------------------

export interface ResponsesReport {
  /** Average minutes to first response. Lower is better — a positive
   *  percentChange here means responses got SLOWER, not "up is good". */
  avgMinutes: OverviewMetric
  series: { day: string; avgMinutes: number | null }[]
}

export async function loadResponsesReport(
  db: DB,
  accountId: string,
  range: DateRange,
): Promise<ResponsesReport> {
  const prev = previousPeriod(range)
  const spanStart = prev.from.toISOString()
  const spanEnd = exclusiveEnd(range.to).toISOString()

  // Pull every message in the full span (current + previous period) in
  // one shot, then walk per-conversation pairing each unanswered
  // customer message with the next outbound reply — same algorithm as
  // the dashboard's loadResponseTime, generalized to an arbitrary
  // range instead of a fixed 14-day window.
  //
  // `messages` carries no account_id of its own (only conversation_id)
  // — tenancy comes from RLS's join to conversations.account_id
  // (migration 017's messages_select policy), same as every other
  // direct messages query in the app.
  const { data, error } = await db
    .from('messages')
    .select('conversation_id, sender_type, created_at')
    .gte('created_at', spanStart)
    .lt('created_at', spanEnd)
    .order('conversation_id', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw error

  const rows = (data ?? []) as { conversation_id: string; sender_type: string; created_at: string }[]

  const samples: { customerAt: Date; diffMin: number }[] = []
  let currentConv = ''
  let pendingCustomer: Date | null = null
  for (const row of rows) {
    if (row.conversation_id !== currentConv) {
      currentConv = row.conversation_id
      pendingCustomer = null
    }
    const ts = new Date(row.created_at)
    if (row.sender_type === 'customer') {
      if (!pendingCustomer) pendingCustomer = ts
    } else if (pendingCustomer) {
      const diffMin = (ts.getTime() - pendingCustomer.getTime()) / 60_000
      if (diffMin >= 0) samples.push({ customerAt: pendingCustomer, diffMin })
      pendingCustomer = null
    }
  }

  const days = dayKeysInRange(range)
  const currentByDay = new Map<string, number[]>(days.map((d) => [d, []]))
  const prevKeys = new Set(dayKeysInRange(prev))
  const previousSamples: number[] = []

  for (const s of samples) {
    const key = localDayKey(s.customerAt)
    if (currentByDay.has(key)) {
      currentByDay.get(key)!.push(s.diffMin)
    } else if (prevKeys.has(key)) {
      previousSamples.push(s.diffMin)
    }
  }

  const avg = (arr: number[]) => (arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length)
  const currentAll = days.flatMap((d) => currentByDay.get(d) ?? [])

  return {
    avgMinutes: {
      current: avg(currentAll) ?? 0,
      previous: avg(previousSamples) ?? 0,
      // Intentionally not using percentChange's "0 previous → null"
      // shortcut here: a 0-sample previous period reads the same as a
      // genuine null either way, so the simple form is fine.
      percentChange: percentChange(avg(currentAll) ?? 0, avg(previousSamples) ?? 0),
    },
    series: days.map((day) => ({ day, avgMinutes: avg(currentByDay.get(day) ?? []) })),
  }
}

// --- Resolutions report (open → closed duration) -------------------------

export interface ResolutionsReport {
  avgMinutes: OverviewMetric
  series: { day: string; avgMinutes: number | null }[]
}

export async function loadResolutionsReport(
  db: DB,
  accountId: string,
  range: DateRange,
): Promise<ResolutionsReport> {
  const prev = previousPeriod(range)
  const spanStart = prev.from.toISOString()
  const spanEnd = exclusiveEnd(range.to).toISOString()

  const { data, error } = await db
    .from('conversations')
    .select('created_at, closed_at')
    .eq('account_id', accountId)
    .not('closed_at', 'is', null)
    .gte('closed_at', spanStart)
    .lt('closed_at', spanEnd)
  if (error) throw error

  const rows = (data ?? []) as { created_at: string; closed_at: string }[]
  const days = dayKeysInRange(range)
  const currentByDay = new Map<string, number[]>(days.map((d) => [d, []]))
  const prevKeys = new Set(dayKeysInRange(prev))
  const previousSamples: number[] = []

  for (const r of rows) {
    const diffMin = (new Date(r.closed_at).getTime() - new Date(r.created_at).getTime()) / 60_000
    if (diffMin < 0) continue
    const key = localDayKey(r.closed_at)
    if (currentByDay.has(key)) {
      currentByDay.get(key)!.push(diffMin)
    } else if (prevKeys.has(key)) {
      previousSamples.push(diffMin)
    }
  }

  const avg = (arr: number[]) => (arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length)
  const currentAll = days.flatMap((d) => currentByDay.get(d) ?? [])

  return {
    avgMinutes: {
      current: avg(currentAll) ?? 0,
      previous: avg(previousSamples) ?? 0,
      percentChange: percentChange(avg(currentAll) ?? 0, avg(previousSamples) ?? 0),
    },
    series: days.map((day) => ({ day, avgMinutes: avg(currentByDay.get(day) ?? []) })),
  }
}

// --- Messages report ------------------------------------------------------

export interface MessagesReport {
  incoming: OverviewMetric
  outgoing: OverviewMetric
  series: { day: string; incoming: number; outgoing: number }[]
}

export async function loadMessagesReport(
  db: DB,
  accountId: string,
  range: DateRange,
): Promise<MessagesReport> {
  const prev = previousPeriod(range)
  const spanStart = prev.from.toISOString()
  const spanEnd = exclusiveEnd(range.to).toISOString()

  // Same as loadResponsesReport above: no account_id column on
  // `messages` itself, scoped via RLS's conversations join instead.
  const { data, error } = await db
    .from('messages')
    .select('created_at, sender_type')
    .gte('created_at', spanStart)
    .lt('created_at', spanEnd)
  if (error) throw error

  const rows = (data ?? []) as { created_at: string; sender_type: string }[]
  const incoming = splitByPeriod(
    rows.filter((r) => r.sender_type === 'customer').map((r) => ({ at: r.created_at })),
    range,
    prev,
  )
  const outgoing = splitByPeriod(
    rows.filter((r) => r.sender_type !== 'customer').map((r) => ({ at: r.created_at })),
    range,
    prev,
  )

  const days = dayKeysInRange(range)
  const incomingCurrent = days.reduce((sum, d) => sum + (incoming.currentByDay.get(d) ?? 0), 0)
  const outgoingCurrent = days.reduce((sum, d) => sum + (outgoing.currentByDay.get(d) ?? 0), 0)

  return {
    incoming: metric(incomingCurrent, incoming.previousTotal),
    outgoing: metric(outgoingCurrent, outgoing.previousTotal),
    series: days.map((day) => ({
      day,
      incoming: incoming.currentByDay.get(day) ?? 0,
      outgoing: outgoing.currentByDay.get(day) ?? 0,
    })),
  }
}

// --- Contacts report -------------------------------------------------------

export interface ContactsReport {
  newContacts: OverviewMetric
  series: { day: string; value: number }[]
}

export async function loadContactsReport(
  db: DB,
  accountId: string,
  range: DateRange,
): Promise<ContactsReport> {
  const prev = previousPeriod(range)
  const spanStart = prev.from.toISOString()
  const spanEnd = exclusiveEnd(range.to).toISOString()

  const { data, error } = await db
    .from('contacts')
    .select('created_at')
    .eq('account_id', accountId)
    .gte('created_at', spanStart)
    .lt('created_at', spanEnd)
  if (error) throw error

  const { currentByDay, previousTotal } = splitByPeriod(
    ((data ?? []) as { created_at: string }[]).map((r) => ({ at: r.created_at })),
    range,
    prev,
  )
  const days = dayKeysInRange(range)
  const current = days.reduce((sum, d) => sum + (currentByDay.get(d) ?? 0), 0)

  return {
    newContacts: metric(current, previousTotal),
    series: days.map((day) => ({ day, value: currentByDay.get(day) ?? 0 })),
  }
}
