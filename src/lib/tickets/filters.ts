import type { Ticket, TicketCategory, TicketPriority, TicketStatus } from '@/types'
import { TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES, isDoneStatus } from './constants'
import { dueState } from './due'
import { ticketMatchesSearch } from './key'
import { normalizeLabel } from './labels'
import { matchesSlaChip } from '@/lib/sla/display'

/** The "Unassigned" entry in the assignee filter. */
export const UNASSIGNED = '__unassigned__'

/** `sla_at_risk` / `sla_breached` (migration 086) read the ticket's SLA columns;
 *  `mentioned` (migration 095) keeps the tickets where someone asked the signed-in
 *  person for a response and it is still open (`FilterContext.mentionedTicketIds`). */
export type QuickFilter = 'mine' | 'mentioned' | 'unassigned' | 'overdue' | 'today' | 'sla_at_risk' | 'sla_breached'
export const QUICK_FILTERS: QuickFilter[] = ['mine', 'mentioned', 'unassigned', 'overdue', 'today', 'sla_at_risk', 'sla_breached']

export interface TicketFilters {
  /** Search box: a key ("VIR-12"), a number, or words. */
  q: string
  /** Quick chips; several may be on and all must match. */
  quick: QuickFilter[]
  /** User ids, or UNASSIGNED. Any of them matches. */
  assignees: string[]
  types: TicketCategory[]
  priorities: TicketPriority[]
  labels: string[]
  /** Team ids. */
  teams: string[]
  /** List view only; the board always shows every column. */
  statuses: TicketStatus[]
}

export function emptyFilters(): TicketFilters {
  return { q: '', quick: [], assignees: [], types: [], priorities: [], labels: [], teams: [], statuses: [] }
}

/** The URL parameters that carry filters (everything else in the query is left alone). */
export const FILTER_PARAMS = ['q', 'quick', 'assignee', 'type', 'priority', 'label', 'team', 'status'] as const

export function hasActiveFilters(f: TicketFilters, includeStatuses = true): boolean {
  return (
    f.q.trim() !== '' ||
    f.quick.length > 0 ||
    f.assignees.length > 0 ||
    f.types.length > 0 ||
    f.priorities.length > 0 ||
    f.labels.length > 0 ||
    f.teams.length > 0 ||
    (includeStatuses && f.statuses.length > 0)
  )
}

/** How many filters are on (for the badge on a filter button). */
export function countActiveFilters(f: TicketFilters, includeStatuses = true): number {
  return (
    (f.q.trim() ? 1 : 0) +
    f.quick.length +
    (f.assignees.length ? 1 : 0) +
    (f.types.length ? 1 : 0) +
    (f.priorities.length ? 1 : 0) +
    (f.labels.length ? 1 : 0) +
    (f.teams.length ? 1 : 0) +
    (includeStatuses && f.statuses.length ? 1 : 0)
  )
}

function list(raw: string | null): string[] {
  if (!raw) return []
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))]
}

function only<T extends string>(raw: string | null, allowed: readonly T[]): T[] {
  return list(raw).filter((v): v is T => (allowed as readonly string[]).includes(v))
}

/** Filters from a URL query (or a saved filter turned into one). Unknown
 *  values are dropped, so a hand-edited link cannot break the page. */
export function parseFilters(params: { get(name: string): string | null }): TicketFilters {
  return {
    q: (params.get('q') ?? '').slice(0, 200),
    quick: only(params.get('quick'), QUICK_FILTERS),
    assignees: list(params.get('assignee')),
    types: only(params.get('type'), TICKET_CATEGORIES),
    priorities: only(params.get('priority'), TICKET_PRIORITIES),
    labels: [...new Set(list(params.get('label')).map(normalizeLabel).filter(Boolean))],
    teams: list(params.get('team')),
    statuses: only(params.get('status'), TICKET_STATUSES),
  }
}

/** `base` with the filter parameters replaced by `f` (empty ones removed). */
export function serializeFilters(f: TicketFilters, base?: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams(base?.toString() ?? '')
  for (const key of FILTER_PARAMS) out.delete(key)
  const set = (key: string, values: string[]) => {
    if (values.length) out.set(key, values.join(','))
  }
  if (f.q.trim()) out.set('q', f.q.trim())
  set('quick', f.quick)
  set('assignee', f.assignees)
  set('type', f.types)
  set('priority', f.priorities)
  set('label', f.labels)
  set('team', f.teams)
  set('status', f.statuses)
  return out
}

/** A saved filter's JSON: the same key/value pairs as the URL. */
export function filtersToJson(f: TicketFilters): Record<string, string> {
  return Object.fromEntries(serializeFilters(f).entries())
}

export function filtersFromJson(json: unknown): TicketFilters {
  const params = new URLSearchParams()
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    for (const [k, v] of Object.entries(json)) {
      if ((FILTER_PARAMS as readonly string[]).includes(k) && typeof v === 'string') params.set(k, v)
    }
  }
  return parseFilters(params)
}

export interface FilterContext {
  /** The signed-in user, for "My tickets". */
  userId: string | null
  /** Tickets with an open "needs your response" request on the signed-in user (migration 095). */
  mentionedTicketIds?: ReadonlySet<string>
  prefix: string | null
  now?: Date
}

function isSameLocalDay(iso: string, now: Date): boolean {
  const d = new Date(iso)
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  )
}

type FilterRow = Pick<
  Ticket,
  | 'ticket_number'
  | 'subject'
  | 'description'
  | 'status'
  | 'priority'
  | 'category'
  | 'assigned_agent_id'
  | 'assigned_team_id'
  | 'labels'
  | 'due_date'
  | 'updated_at'
  | 'sla_first_response_state'
  | 'sla_first_response_due_at'
  | 'sla_first_response_risk_at'
  | 'sla_resolution_state'
  | 'sla_resolution_due_at'
  | 'sla_resolution_risk_at'
> & { id?: string }

/** Whether one ticket passes every filter. `includeStatuses` is false on the
 *  board, which always shows every column. */
export function ticketMatchesFilters(
  t: FilterRow,
  f: TicketFilters,
  ctx: FilterContext,
  includeStatuses = true,
): boolean {
  const now = ctx.now ?? new Date()
  if (f.q.trim() && !ticketMatchesSearch(t, f.q, ctx.prefix)) return false

  for (const chip of f.quick) {
    if (chip === 'mine' && !(ctx.userId && t.assigned_agent_id === ctx.userId)) return false
    if (chip === 'mentioned' && !(t.id !== undefined && ctx.mentionedTicketIds?.has(t.id))) return false
    if (chip === 'unassigned' && t.assigned_agent_id) return false
    if (chip === 'overdue' && dueState(t.due_date, now, isDoneStatus(t.status)) !== 'overdue') return false
    if (chip === 'today' && !isSameLocalDay(t.updated_at, now)) return false
    if ((chip === 'sla_at_risk' || chip === 'sla_breached') && !matchesSlaChip(chip, t, now.getTime())) return false
  }

  if (f.assignees.length) {
    const who = t.assigned_agent_id ?? UNASSIGNED
    if (!f.assignees.includes(who)) return false
  }
  if (f.types.length && !f.types.includes(t.category)) return false
  if (f.priorities.length && !f.priorities.includes(t.priority)) return false
  if (f.labels.length && !(t.labels ?? []).some((l) => f.labels.includes(l))) return false
  if (f.teams.length && !(t.assigned_team_id && f.teams.includes(t.assigned_team_id))) return false
  if (includeStatuses && f.statuses.length && !f.statuses.includes(t.status)) return false
  return true
}

export function applyFilters<T extends FilterRow>(
  rows: T[],
  f: TicketFilters,
  ctx: FilterContext,
  includeStatuses = true,
): T[] {
  return rows.filter((t) => ticketMatchesFilters(t, f, ctx, includeStatuses))
}
