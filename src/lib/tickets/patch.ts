import type { Ticket, TicketPriority, TicketStatus } from '@/types'
import { isDoneStatus } from './constants'
import { MAX_LABELS, normalizeLabel } from './labels'
import { withResolution, type ResolutionChoice } from './resolution'

/**
 * The columns a status change writes: resolving stamps resolved_at, closing
 * stamps closed_at, and moving back to an active status clears both (the
 * same rules the ticket sheet always had).
 */
export function statusPatch(
  status: TicketStatus,
  now: Date = new Date(),
): Pick<Ticket, 'status' | 'resolved_at' | 'closed_at'> {
  const stamp = now.toISOString()
  switch (status) {
    case 'resolved':
      return { status, resolved_at: stamp, closed_at: undefined }
    case 'closed':
      return { status, resolved_at: undefined, closed_at: stamp }
    default:
      return { status, resolved_at: null, closed_at: null }
  }
}

/**
 * A patch ready to write: when it changes the status it also carries the
 * resolved_at / closed_at that goes with it. `undefined` means "leave the
 * column alone" (resolving keeps closed_at, closing keeps resolved_at), so
 * those keys are dropped rather than sent.
 */
export function buildTicketPatch(patch: Partial<Ticket>, now: Date = new Date()): Partial<Ticket> {
  const out: Partial<Ticket> = { ...patch }
  if (patch.status && !('resolved_at' in patch) && !('closed_at' in patch)) {
    Object.assign(out, statusPatch(patch.status, now))
  }
  for (const key of Object.keys(out) as (keyof Ticket)[]) {
    if (out[key] === undefined) delete out[key]
  }
  return out
}

// ---- Bulk edits -----------------------------------------------------------

export type BulkAction =
  /** `resolution`: what the person chose when the status is Resolved or Closed (migration 096). */
  | { kind: 'status'; status: TicketStatus; resolution?: ResolutionChoice | null }
  | { kind: 'assignee'; userId: string | null }
  | { kind: 'priority'; priority: TicketPriority }
  | { kind: 'team'; teamId: string | null }
  | { kind: 'label'; label: string }

export interface BulkUpdate {
  ids: string[]
  patch: Partial<Ticket>
}

export interface BulkPlan {
  updates: BulkUpdate[]
  /** Rows that already had the value (or could not take another label). */
  skipped: number
  /** How many rows the updates touch. */
  changed: number
}

type BulkRow = Pick<
  Ticket,
  'id' | 'status' | 'priority' | 'assigned_agent_id' | 'assigned_team_id' | 'labels'
> & { resolution_id?: string | null }

/**
 * What to write for a bulk edit: one update per field for all rows, except
 * adding a label, which is one update per distinct resulting label list
 * (usually one). Rows that would not change are left out, so nothing is
 * logged for them.
 */
export function buildBulkUpdates(
  action: BulkAction,
  rows: BulkRow[],
  now: Date = new Date(),
): BulkPlan {
  const ids: string[] = []
  let skipped = 0

  if (action.kind === 'label') {
    const label = normalizeLabel(action.label)
    const byResult = new Map<string, { ids: string[]; labels: string[] }>()
    for (const row of rows) {
      const current = row.labels ?? []
      if (!label || current.includes(label) || current.length >= MAX_LABELS) {
        skipped += 1
        continue
      }
      const labels = [...current, label]
      const key = JSON.stringify(labels)
      const group = byResult.get(key) ?? { ids: [], labels }
      group.ids.push(row.id)
      byResult.set(key, group)
    }
    const updates = [...byResult.values()].map((g) => ({ ids: g.ids, patch: { labels: g.labels } }))
    return { updates, skipped, changed: updates.reduce((n, u) => n + u.ids.length, 0) }
  }

  for (const row of rows) {
    const same =
      (action.kind === 'status' && row.status === action.status) ||
      (action.kind === 'priority' && row.priority === action.priority) ||
      (action.kind === 'assignee' && (row.assigned_agent_id ?? null) === action.userId) ||
      (action.kind === 'team' && (row.assigned_team_id ?? null) === action.teamId)
    if (same) skipped += 1
    else ids.push(row.id)
  }
  if (ids.length === 0) return { updates: [], skipped, changed: 0 }

  // Moving to Resolved or Closed: the chosen resolution goes to every ticket
  // except one that is already done and has its own (Resolved -> Closed keeps it).
  if (action.kind === 'status' && action.resolution && isDoneStatus(action.status)) {
    const keep = new Set(
      rows.filter((r) => ids.includes(r.id) && isDoneStatus(r.status) && r.resolution_id).map((r) => r.id),
    )
    const own = ids.filter((id) => keep.has(id))
    const chosen = ids.filter((id) => !keep.has(id))
    const updates: BulkUpdate[] = []
    if (chosen.length > 0) {
      updates.push({ ids: chosen, patch: buildTicketPatch(withResolution({ status: action.status }, action.resolution), now) })
    }
    if (own.length > 0) updates.push({ ids: own, patch: buildTicketPatch({ status: action.status }, now) })
    return { updates, skipped, changed: ids.length }
  }

  let patch: Partial<Ticket>
  switch (action.kind) {
    case 'status':
      patch = buildTicketPatch({ status: action.status }, now)
      break
    case 'assignee':
      patch = { assigned_agent_id: action.userId }
      break
    case 'priority':
      patch = { priority: action.priority }
      break
    default:
      patch = { assigned_team_id: action.teamId }
  }
  return { updates: [{ ids, patch }], skipped, changed: ids.length }
}
