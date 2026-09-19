import type { SupabaseClient } from '@supabase/supabase-js'
import type { LifecycleStage } from '@/types'
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

export interface TicketAgentBucket {
  userId: string
  fullName: string
  ticketsResolved: number
  avgResolutionMinutes: number | null
}

export interface TicketsReport {
  opened: OverviewMetric
  resolved: OverviewMetric
  avgResolutionMinutes: OverviewMetric
  series: { day: string; opened: number; resolved: number }[]
  byAgent: TicketAgentBucket[]
}

export async function loadTicketsReport(
  db: DB,
  accountId: string,
  range: DateRange,
): Promise<TicketsReport> {
  const prev = previousPeriod(range)
  const spanStart = prev.from.toISOString()
  const spanEnd = exclusiveEnd(range.to).toISOString()

  const [openedRes, resolvedRes, profilesRes] = await Promise.all([
    db
      .from('tickets')
      .select('created_at')
      .eq('account_id', accountId)
      .gte('created_at', spanStart)
      .lt('created_at', spanEnd),
    // "Resolved" here covers both `resolved` and `closed` — either is a
    // ticket an agent finished working, same as klink.cloud's own
    // CX Log doesn't distinguish them for duration reporting.
    db
      .from('tickets')
      .select('created_at, resolved_at, closed_at, assigned_agent_id, status')
      .eq('account_id', accountId)
      .in('status', ['resolved', 'closed'])
      .or(`resolved_at.gte.${spanStart},closed_at.gte.${spanStart}`),
    db.from('profiles').select('user_id, full_name').eq('account_id', accountId),
  ])
  if (openedRes.error) throw openedRes.error
  if (resolvedRes.error) throw resolvedRes.error
  if (profilesRes.error) throw profilesRes.error

  const openedRows = (openedRes.data ?? []) as { created_at: string }[]
  const opened = splitByPeriod(openedRows.map((r) => ({ at: r.created_at })), range, prev)
  const days = dayKeysInRange(range)
  const openedCurrent = days.reduce((sum, d) => sum + (opened.currentByDay.get(d) ?? 0), 0)

  type ResolvedRow = {
    created_at: string
    resolved_at: string | null
    closed_at: string | null
    assigned_agent_id: string | null
    status: string
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

  for (const r of resolvedRows) {
    const diffMin = (new Date(r.finishedAt).getTime() - new Date(r.created_at).getTime()) / 60_000
    const key = localDayKey(r.finishedAt)
    if (resolvedByDay.has(key)) {
      resolvedByDay.set(key, (resolvedByDay.get(key) ?? 0) + 1)
      if (diffMin >= 0) resolvedDurationsByDay.get(key)!.push(diffMin)
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
    }))
    .filter((a) => a.ticketsResolved > 0)
    .sort((a, b) => b.ticketsResolved - a.ticketsResolved)

  return {
    opened: metric(openedCurrent, opened.previousTotal),
    resolved: metric(resolvedCurrent, previousResolvedTotal),
    avgResolutionMinutes: {
      current: avg(currentDurationsAll) ?? 0,
      previous: avg(previousDurations) ?? 0,
      percentChange: percentChange(avg(currentDurationsAll) ?? 0, avg(previousDurations) ?? 0),
    },
    series: days.map((day) => ({
      day,
      opened: opened.currentByDay.get(day) ?? 0,
      resolved: resolvedByDay.get(day) ?? 0,
    })),
    byAgent,
  }
}
