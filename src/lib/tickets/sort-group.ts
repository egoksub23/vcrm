import type { Ticket } from '@/types'
import { TICKET_PRIORITIES, TICKET_STATUSES } from './constants'
import { UNASSIGNED } from './filters'

export type SortKey =
  | 'key'
  | 'summary'
  | 'status'
  | 'priority'
  | 'assignee'
  | 'due'
  | 'updated'
  | 'created'

export interface SortSpec {
  key: SortKey
  dir: 'asc' | 'desc'
}

const SORT_KEYS: SortKey[] = ['key', 'summary', 'status', 'priority', 'assignee', 'due', 'updated', 'created']

export const DEFAULT_SORT: SortSpec = { key: 'updated', dir: 'desc' }

/** "updated:desc" -> a spec; anything unrecognised gives the default. */
export function parseSort(raw: string | null | undefined): SortSpec {
  if (!raw) return DEFAULT_SORT
  const [key, dir] = raw.split(':')
  if (!SORT_KEYS.includes(key as SortKey)) return DEFAULT_SORT
  return { key: key as SortKey, dir: dir === 'asc' ? 'asc' : 'desc' }
}

export function serializeSort(spec: SortSpec): string {
  return `${spec.key}:${spec.dir}`
}

/** Clicking a column header: the same column flips direction, a new one
 *  starts ascending for words and newest / latest first for dates. */
export function toggleSort(current: SortSpec, key: SortKey): SortSpec {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
  return { key, dir: key === 'updated' || key === 'created' ? 'desc' : 'asc' }
}

export interface SortContext {
  assigneeName: (userId: string | null | undefined) => string
}

type SortRow = Pick<
  Ticket,
  | 'id'
  | 'ticket_number'
  | 'subject'
  | 'status'
  | 'priority'
  | 'assigned_agent_id'
  | 'due_date'
  | 'updated_at'
  | 'created_at'
>

const text = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })

/** A sorted copy. Tickets without a due date (or assignee) always sort last. */
export function sortTickets<T extends SortRow>(rows: T[], spec: SortSpec, ctx: SortContext): T[] {
  const sign = spec.dir === 'asc' ? 1 : -1
  const out = [...rows]
  out.sort((a, b) => {
    switch (spec.key) {
      case 'key':
        return sign * (a.ticket_number - b.ticket_number)
      case 'summary':
        return sign * text(a.subject, b.subject)
      case 'status':
        return sign * (TICKET_STATUSES.indexOf(a.status) - TICKET_STATUSES.indexOf(b.status))
      case 'priority':
        return sign * (TICKET_PRIORITIES.indexOf(a.priority) - TICKET_PRIORITIES.indexOf(b.priority))
      case 'assignee': {
        const an = a.assigned_agent_id ? ctx.assigneeName(a.assigned_agent_id) : null
        const bn = b.assigned_agent_id ? ctx.assigneeName(b.assigned_agent_id) : null
        if (an === null || bn === null) return an === bn ? 0 : an === null ? 1 : -1
        return sign * text(an, bn)
      }
      case 'due': {
        if (!a.due_date || !b.due_date) return a.due_date === b.due_date ? 0 : !a.due_date ? 1 : -1
        return sign * text(a.due_date, b.due_date)
      }
      case 'created':
        return sign * (new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      default:
        return sign * (new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime())
    }
  })
  return out
}

export type GroupBy = 'none' | 'assignee' | 'status' | 'priority'
export const GROUP_BYS: GroupBy[] = ['none', 'assignee', 'status', 'priority']

export function parseGroupBy(raw: string | null | undefined): GroupBy {
  return GROUP_BYS.includes(raw as GroupBy) ? (raw as GroupBy) : 'none'
}

export interface TicketGroup<T> {
  /** The status / priority / user id (or UNASSIGNED) the group is for. */
  key: string
  rows: T[]
}

/** Rows split into groups in a stable, meaningful order: workflow order for
 *  status, urgency for priority, names for assignees (unassigned last). Rows
 *  keep their incoming order inside a group. */
export function groupTickets<T extends SortRow>(
  rows: T[],
  by: Exclude<GroupBy, 'none'>,
  ctx: SortContext,
): TicketGroup<T>[] {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const key =
      by === 'status' ? row.status : by === 'priority' ? row.priority : (row.assigned_agent_id ?? UNASSIGNED)
    const bucket = groups.get(key)
    if (bucket) bucket.push(row)
    else groups.set(key, [row])
  }
  const keys = [...groups.keys()]
  if (by === 'status') keys.sort((a, b) => TICKET_STATUSES.indexOf(a as never) - TICKET_STATUSES.indexOf(b as never))
  else if (by === 'priority')
    keys.sort((a, b) => TICKET_PRIORITIES.indexOf(a as never) - TICKET_PRIORITIES.indexOf(b as never))
  else
    keys.sort((a, b) => {
      if (a === UNASSIGNED || b === UNASSIGNED) return a === b ? 0 : a === UNASSIGNED ? 1 : -1
      return text(ctx.assigneeName(a), ctx.assigneeName(b))
    })
  return keys.map((key) => ({ key, rows: groups.get(key)! }))
}
