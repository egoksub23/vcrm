import type { SupabaseClient } from '@supabase/supabase-js'
import type { LifecycleStage, TicketStatus } from '@/types'
import { ACTIVE_STATUSES, isActiveStatus } from '@/lib/tickets/constants'
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
    // A message that failed to send never reached the customer: it is not a reply.
    .neq('status', 'failed')
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
    .neq('status', 'failed')
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

// --- Assignments report ----------------------------------------------------

export interface AssignmentBucket {
  id: string | null
  name: string
  count: number
}

export interface AssignmentsReport {
  totalConversations: number
  byAgent: AssignmentBucket[]
  byTeam: AssignmentBucket[]
}

/** Conversations created within `range`, distributed across agents and
 *  teams — the columns already exist (`assigned_agent_id`,
 *  `assigned_team_id`), this is a count-by-agent/team over what's
 *  already there. `id: null` is the "Unassigned" bucket in each list. */
export async function loadAssignmentsReport(
  db: DB,
  accountId: string,
  range: DateRange,
): Promise<AssignmentsReport> {
  const spanStart = range.from.toISOString()
  const spanEnd = exclusiveEnd(range.to).toISOString()

  const [convRes, profilesRes, teamsRes] = await Promise.all([
    db
      .from('conversations')
      .select('assigned_agent_id, assigned_team_id')
      .eq('account_id', accountId)
      .gte('created_at', spanStart)
      .lt('created_at', spanEnd),
    db.from('profiles').select('user_id, full_name').eq('account_id', accountId),
    db.from('teams').select('id, name').eq('account_id', accountId),
  ])
  if (convRes.error) throw convRes.error
  if (profilesRes.error) throw profilesRes.error
  if (teamsRes.error) throw teamsRes.error

  const rows = (convRes.data ?? []) as {
    assigned_agent_id: string | null
    assigned_team_id: string | null
  }[]
  const nameByAgent = new Map(
    ((profilesRes.data ?? []) as { user_id: string; full_name: string }[]).map((p) => [
      p.user_id,
      p.full_name,
    ]),
  )
  const nameByTeam = new Map(
    ((teamsRes.data ?? []) as { id: string; name: string }[]).map((tm) => [tm.id, tm.name]),
  )

  const agentCounts = new Map<string | null, number>()
  const teamCounts = new Map<string | null, number>()
  for (const r of rows) {
    agentCounts.set(r.assigned_agent_id, (agentCounts.get(r.assigned_agent_id) ?? 0) + 1)
    teamCounts.set(r.assigned_team_id, (teamCounts.get(r.assigned_team_id) ?? 0) + 1)
  }

  const toBuckets = (
    counts: Map<string | null, number>,
    names: Map<string, string>,
    unassignedLabel: string,
  ): AssignmentBucket[] =>
    Array.from(counts.entries())
      .map(([id, count]) => ({
        id,
        name: id === null ? unassignedLabel : (names.get(id) ?? unassignedLabel),
        count,
      }))
      .sort((a, b) => b.count - a.count)

  return {
    totalConversations: rows.length,
    byAgent: toBuckets(agentCounts, nameByAgent, 'Unassigned'),
    byTeam: toBuckets(teamCounts, nameByTeam, 'No team'),
  }
}

// --- Shared per-agent stats (Leaderboard + Users reports) ------------------

interface AgentStats {
  userId: string
  fullName: string
  email: string
  memberSince: string
  messagesSent: number
  conversationsAssigned: number
  conversationsClosed: number
  avgResponseMinutes: number | null
}

/** One pass computing everything both the Leaderboard and Users reports
 *  need per agent: message volume (via `messages.sender_id`, populated
 *  for an ordinary agent send starting with this reporting work — NULL
 *  for every message sent before then, so older activity undercounts,
 *  same accepted gap as `closed_at`'s backfill), conversations
 *  assigned/closed, and average first-response time attributed to
 *  whichever agent's reply actually answered the
 *  customer. */
async function loadAgentStats(
  db: DB,
  accountId: string,
  range: DateRange,
): Promise<AgentStats[]> {
  const spanStart = range.from.toISOString()
  const spanEnd = exclusiveEnd(range.to).toISOString()

  const [profilesRes, messagesRes, convRes] = await Promise.all([
    db
      .from('profiles')
      .select('user_id, full_name, email, created_at')
      .eq('account_id', accountId),
    db
      .from('messages')
      .select('conversation_id, sender_type, sender_id, created_at')
      .neq('status', 'failed')
      .gte('created_at', spanStart)
      .lt('created_at', spanEnd)
      .order('conversation_id', { ascending: true })
      .order('created_at', { ascending: true }),
    db
      .from('conversations')
      .select('assigned_agent_id, created_at, closed_at')
      .eq('account_id', accountId)
      .gte('created_at', spanStart)
      .lt('created_at', spanEnd),
  ])
  if (profilesRes.error) throw profilesRes.error
  if (messagesRes.error) throw messagesRes.error
  if (convRes.error) throw convRes.error

  const profiles = (profilesRes.data ?? []) as {
    user_id: string
    full_name: string
    email: string
    created_at: string
  }[]
  const messageRows = (messagesRes.data ?? []) as {
    conversation_id: string
    sender_type: string
    sender_id: string | null
    created_at: string
  }[]
  const convRows = (convRes.data ?? []) as {
    assigned_agent_id: string | null
    created_at: string
    closed_at: string | null
  }[]

  const messagesSent = new Map<string, number>()
  const responseSamples = new Map<string, number[]>()
  let currentConv = ''
  let pendingCustomer: Date | null = null
  for (const row of messageRows) {
    if (row.conversation_id !== currentConv) {
      currentConv = row.conversation_id
      pendingCustomer = null
    }
    if (row.sender_type === 'customer') {
      if (!pendingCustomer) pendingCustomer = new Date(row.created_at)
      continue
    }
    if (row.sender_type === 'agent' && row.sender_id) {
      messagesSent.set(row.sender_id, (messagesSent.get(row.sender_id) ?? 0) + 1)
      if (pendingCustomer) {
        const diffMin = (new Date(row.created_at).getTime() - pendingCustomer.getTime()) / 60_000
        if (diffMin >= 0) {
          const arr = responseSamples.get(row.sender_id) ?? []
          arr.push(diffMin)
          responseSamples.set(row.sender_id, arr)
        }
        pendingCustomer = null
      }
    } else if (pendingCustomer) {
      // A bot/system reply answered the customer — clears the wait but
      // isn't attributable to any one agent's response time.
      pendingCustomer = null
    }
  }

  const conversationsAssigned = new Map<string, number>()
  const conversationsClosed = new Map<string, number>()
  for (const r of convRows) {
    if (!r.assigned_agent_id) continue
    conversationsAssigned.set(
      r.assigned_agent_id,
      (conversationsAssigned.get(r.assigned_agent_id) ?? 0) + 1,
    )
    if (r.closed_at) {
      conversationsClosed.set(
        r.assigned_agent_id,
        (conversationsClosed.get(r.assigned_agent_id) ?? 0) + 1,
      )
    }
  }

  const avg = (arr: number[] | undefined) =>
    !arr || arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length

  return profiles.map((p) => ({
    userId: p.user_id,
    fullName: p.full_name,
    email: p.email,
    memberSince: p.created_at,
    messagesSent: messagesSent.get(p.user_id) ?? 0,
    conversationsAssigned: conversationsAssigned.get(p.user_id) ?? 0,
    conversationsClosed: conversationsClosed.get(p.user_id) ?? 0,
    avgResponseMinutes: avg(responseSamples.get(p.user_id)),
  }))
}

// --- Leaderboard report ------------------------------------------------------

export interface LeaderboardEntry extends AgentStats {
  rank: number
}

export interface LeaderboardReport {
  entries: LeaderboardEntry[]
}

/** Ranked by message volume (the metric respond.io's own Leaderboard
 *  defaults to) — ties broken by more conversations closed. */
export async function loadLeaderboardReport(
  db: DB,
  accountId: string,
  range: DateRange,
): Promise<LeaderboardReport> {
  const stats = await loadAgentStats(db, accountId, range)
  const sorted = [...stats].sort(
    (a, b) => b.messagesSent - a.messagesSent || b.conversationsClosed - a.conversationsClosed,
  )
  return { entries: sorted.map((s, i) => ({ ...s, rank: i + 1 })) }
}

// --- Users report ------------------------------------------------------------

export interface UsersReport {
  users: AgentStats[]
}

/** Per-teammate activity summary for the selected range — message
 *  volume, conversations assigned/closed, average response time, and
 *  "member since" (profiles.created_at, real data). NOT a login/audit
 *  history: `member_presence` only stores a live online/away snapshot
 *  with no history table behind it, so that specific respond.io feature
 *  stays out of scope here rather than being faked. */
export async function loadUsersReport(
  db: DB,
  accountId: string,
  range: DateRange,
): Promise<UsersReport> {
  const users = await loadAgentStats(db, accountId, range)
  return { users: users.sort((a, b) => a.fullName.localeCompare(b.fullName)) }
}

// --- Lifecycle report --------------------------------------------------------

export const LIFECYCLE_STAGES: readonly LifecycleStage[] = [
  'lead',
  'active',
  'customer',
  'churned',
] as const

export interface LifecycleReport {
  /** Current snapshot — every contact counted once, by their stage
   *  right now. Not range-scoped: a stage is current-state, not an
   *  event. */
  distribution: Record<LifecycleStage, number>
  /** Contacts whose most recent stage transition fell within `range`,
   *  by the stage they moved TO. Approximate — migration 052 only
   *  tracks the latest transition, not full history, so a contact that
   *  changed stage twice in one day only counts once, under its final
   *  stage. Documented in the report UI, not silently exact. */
  movedIn: Record<LifecycleStage, number>
}

export async function loadLifecycleReport(
  db: DB,
  accountId: string,
  range: DateRange,
): Promise<LifecycleReport> {
  const spanStart = range.from.toISOString()
  const spanEnd = exclusiveEnd(range.to).toISOString()

  const [allRes, movedRes] = await Promise.all([
    db.from('contacts').select('lifecycle_stage').eq('account_id', accountId),
    db
      .from('contacts')
      .select('lifecycle_stage')
      .eq('account_id', accountId)
      .not('lifecycle_stage_changed_at', 'is', null)
      .gte('lifecycle_stage_changed_at', spanStart)
      .lt('lifecycle_stage_changed_at', spanEnd),
  ])
  if (allRes.error) throw allRes.error
  if (movedRes.error) throw movedRes.error

  const emptyDist = (): Record<LifecycleStage, number> => ({
    lead: 0,
    active: 0,
    customer: 0,
    churned: 0,
  })
  const distribution = emptyDist()
  for (const r of (allRes.data ?? []) as { lifecycle_stage: LifecycleStage }[]) {
    distribution[r.lifecycle_stage] = (distribution[r.lifecycle_stage] ?? 0) + 1
  }
  const movedIn = emptyDist()
  for (const r of (movedRes.data ?? []) as { lifecycle_stage: LifecycleStage }[]) {
    movedIn[r.lifecycle_stage] = (movedIn[r.lifecycle_stage] ?? 0) + 1
  }

  return { distribution, movedIn }
}

// --- Broadcasts report --------------------------------------------------------

export interface BroadcastsReport {
  broadcastsSent: OverviewMetric
  totalRecipients: OverviewMetric
  /** delivered / sent across every broadcast in range, 0–100. Not an
   *  OverviewMetric — a rate, not a count, so "vs previous period" reads
   *  as a plain point difference rather than a %-of-a-% change. */
  deliveredRate: number | null
  readRate: number | null
  failedRate: number | null
  series: { day: string; sent: number }[]
}

export async function loadBroadcastsReport(
  db: DB,
  accountId: string,
  range: DateRange,
): Promise<BroadcastsReport> {
  const prev = previousPeriod(range)
  const spanStart = prev.from.toISOString()
  const spanEnd = exclusiveEnd(range.to).toISOString()

  const { data, error } = await db
    .from('broadcasts')
    .select('created_at, total_recipients, sent_count, delivered_count, read_count, failed_count')
    .eq('account_id', accountId)
    .gte('created_at', spanStart)
    .lt('created_at', spanEnd)
  if (error) throw error

  const rows = (data ?? []) as {
    created_at: string
    total_recipients: number | null
    sent_count: number | null
    delivered_count: number | null
    read_count: number | null
    failed_count: number | null
  }[]

  const days = dayKeysInRange(range)
  const prevKeys = new Set(dayKeysInRange(prev))
  const currentByDay = new Map(days.map((d) => [d, 0]))
  let previousBroadcasts = 0
  let currentRecipients = 0
  let previousRecipients = 0
  let sentTotal = 0
  let deliveredTotal = 0
  let readTotal = 0
  let failedTotal = 0

  for (const r of rows) {
    const key = localDayKey(r.created_at)
    const recipients = r.total_recipients ?? 0
    if (currentByDay.has(key)) {
      currentByDay.set(key, (currentByDay.get(key) ?? 0) + 1)
      currentRecipients += recipients
      sentTotal += r.sent_count ?? 0
      deliveredTotal += r.delivered_count ?? 0
      readTotal += r.read_count ?? 0
      failedTotal += r.failed_count ?? 0
    } else if (prevKeys.has(key)) {
      previousBroadcasts += 1
      previousRecipients += recipients
    }
  }

  const broadcastsCurrent = days.reduce((sum, d) => sum + (currentByDay.get(d) ?? 0), 0)
  const rate = (num: number, den: number) => (den === 0 ? null : (num / den) * 100)

  return {
    broadcastsSent: metric(broadcastsCurrent, previousBroadcasts),
    totalRecipients: metric(currentRecipients, previousRecipients),
    deliveredRate: rate(deliveredTotal, sentTotal),
    readRate: rate(readTotal, sentTotal),
    failedRate: rate(failedTotal, sentTotal),
    series: days.map((day) => ({ day, sent: currentByDay.get(day) ?? 0 })),
  }
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

// --- Tickets report ---------------------------------------------------------
// Added after auditing Ticketing (migration 063) against klink.cloud —
// there was no ticket-scoped analytics at all, only conversation-scoped
// reports below. Mirrors loadConversationsReport (opened/closed pattern)
// + loadResolutionsReport (open→resolved duration) + the per-agent
// breakdown shape loadAgentStats already established for Leaderboard.
// Extended into a fuller "ticket performance" view: first-response time,
// resolved-within-24h rate, live backlog + its age, and category /
// priority / team breakdowns.

export interface TicketAgentBucket {
  userId: string
  fullName: string
  ticketsResolved: number
  avgResolutionMinutes: number | null
  /** Tickets assigned to them that are open / in progress / pending right
   *  now (not range-bound — a live workload figure). */
  openNow: number
}

export interface TicketBreakdownRow {
  /** category / priority value, or a team id ('' = no team). */
  key: string
  /** Team name for the team breakdown; null otherwise (the UI translates
   *  category and priority keys itself). */
  label: string | null
  opened: number
  resolved: number
  avgResolutionMinutes: number | null
}

/** One row of "Resolved by resolution" (migration 096). */
export interface TicketResolutionRow {
  /** The resolution id; '' = tickets resolved with no resolution recorded (before resolutions existed, or the workspace does not require one). */
  key: string
  /** Its name (archived ones keep theirs); null for '' and for an id that no longer exists. */
  label: string | null
  resolved: number
  /** Share of the tickets resolved in the period, 0 to 100. */
  sharePct: number
}

export interface TicketAging {
  under1d: number
  d1to3: number
  d3to7: number
  over7d: number
}

export interface TicketsReport {
  opened: OverviewMetric
  resolved: OverviewMetric
  avgResolutionMinutes: OverviewMetric
  /** Ticket created → the first teammate comment on it, for tickets
   *  opened in the period. */
  avgFirstResponseMinutes: OverviewMetric
  /** Share of tickets resolved in the period that took ≤ 24h; null when
   *  none were resolved. */
  resolvedWithin24hPct: number | null
  /** Open + in progress + pending tickets right now, and how old they are. */
  openNow: number
  aging: TicketAging
  series: { day: string; opened: number; resolved: number }[]
  byAgent: TicketAgentBucket[]
  byCategory: TicketBreakdownRow[]
  byPriority: TicketBreakdownRow[]
  byTeam: TicketBreakdownRow[]
  /** Tickets resolved or closed in the period, by how they were resolved. */
  byResolution: TicketResolutionRow[]
}

const PRIORITY_ORDER = ['urgent', 'high', 'normal', 'low']

export async function loadTicketsReport(
  db: DB,
  accountId: string,
  range: DateRange,
): Promise<TicketsReport> {
  const prev = previousPeriod(range)
  const spanStart = prev.from.toISOString()
  const spanEnd = exclusiveEnd(range.to).toISOString()

  const [openedRes, resolvedRes, openNowRes, commentsRes, profilesRes, teamsRes, resolutionsRes] =
    await Promise.all([
      db
        .from('tickets')
        .select('id, created_at, category, priority, assigned_team_id')
        .eq('account_id', accountId)
        .gte('created_at', spanStart)
        .lt('created_at', spanEnd),
      // "Resolved" here covers both `resolved` and `closed` — either is a
      // ticket an agent finished working, same as klink.cloud's own
      // CX Log doesn't distinguish them for duration reporting.
      db
        .from('tickets')
        .select(
          'created_at, resolved_at, closed_at, assigned_agent_id, assigned_team_id, category, priority, status, resolution_id',
        )
        .eq('account_id', accountId)
        .in('status', ['resolved', 'closed'])
        .or(`resolved_at.gte.${spanStart},closed_at.gte.${spanStart}`),
      // Live backlog — deliberately NOT range-bound.
      db
        .from('tickets')
        .select('created_at, assigned_agent_id, status')
        .eq('account_id', accountId)
        .in('status', ACTIVE_STATUSES),
      // Any comment inside the span is enough to find the first one on
      // tickets opened in it (a comment can't predate its ticket). Same
      // client-side-aggregation scale caveat as the rest of this file.
      db
        .from('ticket_comments')
        .select('ticket_id, created_at')
        .eq('account_id', accountId)
        .gte('created_at', spanStart)
        .lt('created_at', spanEnd)
        .order('created_at', { ascending: true }),
      db.from('profiles').select('user_id, full_name').eq('account_id', accountId),
      db.from('teams').select('id, name').eq('account_id', accountId),
      db.from('ticket_resolutions').select('id, name').eq('account_id', accountId),
    ])
  for (const res of [openedRes, resolvedRes, openNowRes, commentsRes, profilesRes, teamsRes, resolutionsRes]) {
    if (res.error) throw res.error
  }

  type OpenedRow = {
    id: string
    created_at: string
    category: string | null
    priority: string | null
    assigned_team_id: string | null
  }
  const openedRows = (openedRes.data ?? []) as OpenedRow[]
  const opened = splitByPeriod(openedRows.map((r) => ({ at: r.created_at })), range, prev)
  const days = dayKeysInRange(range)
  const openedCurrent = days.reduce((sum, d) => sum + (opened.currentByDay.get(d) ?? 0), 0)
  const inCurrentRange = (iso: string) => opened.currentByDay.has(localDayKey(iso))

  type ResolvedRow = {
    created_at: string
    resolved_at: string | null
    closed_at: string | null
    assigned_agent_id: string | null
    assigned_team_id: string | null
    category: string | null
    priority: string | null
    status: string
    resolution_id?: string | null
  }
  const resolvedRows = ((resolvedRes.data ?? []) as ResolvedRow[])
    .map((r) => ({ ...r, finishedAt: r.resolved_at ?? r.closed_at }))
    .filter((r): r is ResolvedRow & { finishedAt: string } => {
      if (!r.finishedAt) return false
      const t = new Date(r.finishedAt).getTime()
      return t >= new Date(spanStart).getTime() && t < new Date(spanEnd).getTime()
    })

  const prevKeys = new Set(dayKeysInRange(prev))
  const resolvedByDay = new Map<string, number>(days.map((d) => [d, 0]))
  const resolvedDurationsByDay = new Map<string, number[]>(days.map((d) => [d, []]))
  let previousResolvedTotal = 0
  const previousDurations: number[] = []
  const byAgentResolved = new Map<string, number>()
  const byAgentDurations = new Map<string, number[]>()
  let resolvedCurrentCount = 0
  let resolvedWithin24h = 0

  // Breakdown accumulators, current period only.
  type Acc = { opened: number; resolved: number; durations: number[] }
  const newAcc = (): Acc => ({ opened: 0, resolved: 0, durations: [] })
  const cat = new Map<string, Acc>()
  const pri = new Map<string, Acc>()
  const team = new Map<string, Acc>()
  const byResolutionCount = new Map<string, number>()
  const acc = (m: Map<string, Acc>, k: string) => {
    let a = m.get(k)
    if (!a) m.set(k, (a = newAcc()))
    return a
  }

  for (const r of openedRows) {
    if (!inCurrentRange(r.created_at)) continue
    acc(cat, r.category ?? 'other').opened += 1
    acc(pri, r.priority ?? 'normal').opened += 1
    acc(team, r.assigned_team_id ?? '').opened += 1
  }

  for (const r of resolvedRows) {
    const diffMin = (new Date(r.finishedAt).getTime() - new Date(r.created_at).getTime()) / 60_000
    const key = localDayKey(r.finishedAt)
    if (resolvedByDay.has(key)) {
      resolvedByDay.set(key, (resolvedByDay.get(key) ?? 0) + 1)
      resolvedCurrentCount += 1
      byResolutionCount.set(r.resolution_id ?? '', (byResolutionCount.get(r.resolution_id ?? '') ?? 0) + 1)
      if (diffMin >= 0) {
        resolvedDurationsByDay.get(key)!.push(diffMin)
        if (diffMin <= 24 * 60) resolvedWithin24h += 1
      }
      for (const [m, k] of [
        [cat, r.category ?? 'other'],
        [pri, r.priority ?? 'normal'],
        [team, r.assigned_team_id ?? ''],
      ] as [Map<string, Acc>, string][]) {
        const a = acc(m, k)
        a.resolved += 1
        if (diffMin >= 0) a.durations.push(diffMin)
      }
    } else if (prevKeys.has(key)) {
      previousResolvedTotal += 1
      if (diffMin >= 0) previousDurations.push(diffMin)
    }
    if (r.assigned_agent_id && diffMin >= 0) {
      byAgentResolved.set(r.assigned_agent_id, (byAgentResolved.get(r.assigned_agent_id) ?? 0) + 1)
      const arr = byAgentDurations.get(r.assigned_agent_id) ?? []
      arr.push(diffMin)
      byAgentDurations.set(r.assigned_agent_id, arr)
    }
  }

  // First response: earliest comment per ticket (rows arrive ascending).
  const createdById = new Map(openedRows.map((r) => [r.id, r.created_at]))
  const firstComment = new Map<string, string>()
  for (const c of (commentsRes.data ?? []) as { ticket_id: string; created_at: string }[]) {
    if (!firstComment.has(c.ticket_id)) firstComment.set(c.ticket_id, c.created_at)
  }
  const frCurrent: number[] = []
  const frPrevious: number[] = []
  for (const [ticketId, at] of firstComment) {
    const createdAt = createdById.get(ticketId)
    if (!createdAt) continue
    const diffMin = (new Date(at).getTime() - new Date(createdAt).getTime()) / 60_000
    if (diffMin < 0) continue
    if (inCurrentRange(createdAt)) frCurrent.push(diffMin)
    else if (prevKeys.has(localDayKey(createdAt))) frPrevious.push(diffMin)
  }

  // Live backlog + age.
  const openNowRows = ((openNowRes.data ?? []) as {
    created_at: string
    assigned_agent_id: string | null
    status: string
  }[]).filter((r) => isActiveStatus(r.status as TicketStatus))
  const aging: TicketAging = { under1d: 0, d1to3: 0, d3to7: 0, over7d: 0 }
  const openByAgent = new Map<string, number>()
  const now = Date.now()
  for (const r of openNowRows) {
    const ageDays = (now - new Date(r.created_at).getTime()) / 86_400_000
    if (ageDays < 1) aging.under1d += 1
    else if (ageDays < 3) aging.d1to3 += 1
    else if (ageDays < 7) aging.d3to7 += 1
    else aging.over7d += 1
    if (r.assigned_agent_id) {
      openByAgent.set(r.assigned_agent_id, (openByAgent.get(r.assigned_agent_id) ?? 0) + 1)
    }
  }

  const avg = (arr: number[]) => (arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length)
  const resolvedCurrent = days.reduce((sum, d) => sum + (resolvedByDay.get(d) ?? 0), 0)
  const currentDurationsAll = days.flatMap((d) => resolvedDurationsByDay.get(d) ?? [])

  const profiles = (profilesRes.data ?? []) as { user_id: string; full_name: string }[]
  const byAgent: TicketAgentBucket[] = profiles
    .map((p) => ({
      userId: p.user_id,
      fullName: p.full_name,
      ticketsResolved: byAgentResolved.get(p.user_id) ?? 0,
      avgResolutionMinutes: avg(byAgentDurations.get(p.user_id) ?? []),
      openNow: openByAgent.get(p.user_id) ?? 0,
    }))
    .filter((a) => a.ticketsResolved > 0 || a.openNow > 0)
    .sort((a, b) => b.ticketsResolved - a.ticketsResolved || b.openNow - a.openNow)

  const teamNames = new Map(
    ((teamsRes.data ?? []) as { id: string; name: string }[]).map((t) => [t.id, t.name]),
  )
  const rows = (m: Map<string, Acc>, label?: (k: string) => string | null): TicketBreakdownRow[] =>
    [...m.entries()].map(([key, a]) => ({
      key,
      label: label ? label(key) : null,
      opened: a.opened,
      resolved: a.resolved,
      avgResolutionMinutes: avg(a.durations),
    }))
  const byOpenedDesc = (a: TicketBreakdownRow, b: TicketBreakdownRow) =>
    b.opened - a.opened || b.resolved - a.resolved

  return {
    opened: metric(openedCurrent, opened.previousTotal),
    resolved: metric(resolvedCurrent, previousResolvedTotal),
    avgResolutionMinutes: {
      current: avg(currentDurationsAll) ?? 0,
      previous: avg(previousDurations) ?? 0,
      percentChange: percentChange(avg(currentDurationsAll) ?? 0, avg(previousDurations) ?? 0),
    },
    avgFirstResponseMinutes: {
      current: avg(frCurrent) ?? 0,
      previous: avg(frPrevious) ?? 0,
      percentChange: percentChange(avg(frCurrent) ?? 0, avg(frPrevious) ?? 0),
    },
    resolvedWithin24hPct:
      resolvedCurrentCount === 0 ? null : (resolvedWithin24h / resolvedCurrentCount) * 100,
    openNow: openNowRows.length,
    aging,
    series: days.map((day) => ({
      day,
      opened: opened.currentByDay.get(day) ?? 0,
      resolved: resolvedByDay.get(day) ?? 0,
    })),
    byAgent,
    byCategory: rows(cat).sort(byOpenedDesc),
    byPriority: rows(pri).sort(
      (a, b) => PRIORITY_ORDER.indexOf(a.key) - PRIORITY_ORDER.indexOf(b.key),
    ),
    byTeam: rows(team, (k) => (k === '' ? null : (teamNames.get(k) ?? null))).sort(byOpenedDesc),
    byResolution: resolutionRows(
      byResolutionCount,
      new Map(((resolutionsRes.data ?? []) as { id: string; name: string }[]).map((r) => [r.id, r.name])),
    ),
  }
}

/**
 * "Resolved by resolution": the tickets resolved in the period grouped by how
 * they were resolved, most first, with each one's share of the total. Tickets
 * with no resolution recorded are one row (key '') at the end.
 */
export function resolutionRows(
  counts: ReadonlyMap<string, number>,
  names: ReadonlyMap<string, string>,
): TicketResolutionRow[] {
  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  if (total === 0) return []
  return [...counts.entries()]
    .map(([key, resolved]) => ({
      key,
      label: key === '' ? null : (names.get(key) ?? null),
      resolved,
      sharePct: (resolved / total) * 100,
    }))
    .sort((a, b) => Number(a.key === '') - Number(b.key === '') || b.resolved - a.resolved || (a.label ?? '').localeCompare(b.label ?? ''))
}

// --- Tickets report: SLA compliance (migration 086) --------------------------------
// One server-side aggregate (`ticket_sla_report`, SQL): the counts are computed
// in the database over the tickets CREATED in the range that have (or had) an
// SLA, not over rows in the browser. "running" counts targets that are still
// running or paused. A target is "met" or "breached" once it is settled; the
// compliance % is met / (met + breached), so tickets still on the clock do not
// count for or against it.

export interface SlaCounts {
  met: number
  breached: number
  /** Still running (or paused): not settled yet. */
  running: number
}

export interface SlaBreakdownRow {
  /** Priority value, or a team id ('' = no team). */
  key: string
  /** Team name for the team breakdown; null otherwise. */
  label: string | null
  firstResponse: SlaCounts
  resolution: SlaCounts
}

export interface SlaBreachedTicket {
  ticketId: string
  ticketNumber: number
  subject: string
  assigneeId: string | null
  target: 'first_response' | 'resolution'
  dueAt: string
  /** Wall-clock seconds past the due time (until the response / stop, or now). */
  overdueSeconds: number
}

export interface TicketSlaReport {
  firstResponse: SlaCounts
  resolution: SlaCounts
  byPriority: SlaBreakdownRow[]
  byTeam: SlaBreakdownRow[]
  breached: SlaBreachedTicket[]
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const slaCounts = (v: unknown): SlaCounts => {
  const o = (v ?? {}) as Record<string, unknown>
  return { met: num(o.met), breached: num(o.breached), running: num(o.running) }
}

/** met / (met + breached) as a percentage; null when nothing has settled. */
export function slaCompliancePct(c: SlaCounts): number | null {
  const settled = c.met + c.breached
  return settled === 0 ? null : (c.met / settled) * 100
}

export const SLA_BREACHED_LIST_LIMIT = 25

export async function loadTicketSlaReport(
  db: DB,
  accountId: string,
  range: DateRange,
): Promise<TicketSlaReport> {
  const { data, error } = await db.rpc('ticket_sla_report', {
    p_account: accountId,
    p_from: range.from.toISOString(),
    p_to: exclusiveEnd(range.to).toISOString(),
    p_limit: SLA_BREACHED_LIST_LIMIT,
  })
  if (error) throw error
  const d = (data ?? {}) as Record<string, unknown>
  const rows = (v: unknown): SlaBreakdownRow[] =>
    (Array.isArray(v) ? v : []).map((r) => {
      const o = r as Record<string, unknown>
      return {
        key: String(o.key ?? ''),
        label: typeof o.label === 'string' ? o.label : null,
        firstResponse: slaCounts(o.firstResponse),
        resolution: slaCounts(o.resolution),
      }
    })
  return {
    firstResponse: slaCounts(d.firstResponse),
    resolution: slaCounts(d.resolution),
    byPriority: rows(d.byPriority),
    byTeam: rows(d.byTeam),
    breached: (Array.isArray(d.breached) ? d.breached : []).map((r) => {
      const o = r as Record<string, unknown>
      return {
        ticketId: String(o.ticketId ?? ''),
        ticketNumber: num(o.ticketNumber),
        subject: String(o.subject ?? ''),
        assigneeId: typeof o.assigneeId === 'string' ? o.assigneeId : null,
        target: o.target === 'resolution' ? 'resolution' : 'first_response',
        dueAt: String(o.dueAt ?? ''),
        overdueSeconds: num(o.overdueSeconds),
      }
    }),
  }
}
