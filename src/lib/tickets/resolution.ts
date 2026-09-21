import type { Ticket, TicketResolution, TicketStatus } from '@/types'
import { isDoneStatus } from './constants'

/** Migration 096: the longest resolution note. */
export const RESOLUTION_NOTE_MAX = 2000

/** What the person chose in the "How was it resolved?" dialog. */
export interface ResolutionChoice {
  resolutionId: string
  /** Optional free text; null when left empty. */
  note: string | null
}

/** The database's message for a status change that needs a resolution. */
export const RESOLUTION_REQUIRED = 'resolution_required'
export const RESOLUTION_INVALID = 'resolution_invalid'

/** The resolutions that can be picked (not archived), in the order the admin set. */
export function activeResolutions(list: readonly TicketResolution[]): TicketResolution[] {
  return list
    .filter((r) => r.is_active)
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
}

/**
 * Whether moving a ticket to `to` has to ask "how was it resolved?": always
 * when it enters Resolved or Closed from an active status (an earlier
 * resolution is kept by a re-open, so the dialog offers it again, but the
 * person confirms it), and when it moves between the two done statuses with
 * no resolution yet (tickets closed before resolutions existed).
 */
export function needsResolutionPrompt(
  from: TicketStatus,
  to: TicketStatus,
  currentResolutionId: string | null | undefined,
): boolean {
  if (!isDoneStatus(to) || from === to) return false
  if (!isDoneStatus(from)) return true
  return !currentResolutionId
}

/** Whether any of these tickets needs the dialog for a move to `to` (bulk: one dialog for all). */
export function anyNeedsResolutionPrompt(
  rows: readonly Pick<Ticket, 'status' | 'resolution_id'>[],
  to: TicketStatus,
): boolean {
  return rows.some((r) => needsResolutionPrompt(r.status, to, r.resolution_id))
}

export type ResolutionProblem = 'choose' | 'unavailable' | 'noteTooLong'

/** Why the dialog cannot be confirmed yet, or null when it can. */
export function validateResolutionChoice(input: {
  resolutionId: string | null
  note: string
  active: readonly TicketResolution[]
}): ResolutionProblem | null {
  if (!input.resolutionId) return 'choose'
  if (!input.active.some((r) => r.id === input.resolutionId)) return 'unavailable'
  if (input.note.length > RESOLUTION_NOTE_MAX) return 'noteTooLong'
  return null
}

/** The choice as the columns to write (note trimmed, empty becomes null). */
export function resolutionColumns(choice: ResolutionChoice): Pick<Ticket, 'resolution_id' | 'resolution_note'> {
  const note = choice.note?.trim() ?? ''
  return { resolution_id: choice.resolutionId, resolution_note: note === '' ? null : note }
}

/** `patch` with the chosen resolution added (only a done status carries one). */
export function withResolution(patch: Partial<Ticket>, choice: ResolutionChoice | null): Partial<Ticket> {
  if (!choice || !patch.status || !isDoneStatus(patch.status)) return patch
  return { ...patch, ...resolutionColumns(choice) }
}

/** The resolution errors the database raises, from a Supabase / Postgres error. */
export function resolutionErrorCode(
  error: { message?: string | null; code?: string | null } | null | undefined,
): 'resolution_required' | 'resolution_invalid' | null {
  const message = error?.message ?? ''
  if (message.includes(RESOLUTION_REQUIRED)) return RESOLUTION_REQUIRED
  if (message.includes(RESOLUTION_INVALID)) return RESOLUTION_INVALID
  return null
}

/** A resolution's name for display: archived ones stay readable, an unknown id shows nothing. */
export function resolutionName(
  byId: ReadonlyMap<string, TicketResolution>,
  id: string | null | undefined,
): string | null {
  return id ? (byId.get(id)?.name ?? null) : null
}

/** Whether the ticket should show its resolution (only while it is Resolved or Closed). */
export function showsResolution(t: Pick<Ticket, 'status' | 'resolution_id'>): boolean {
  return isDoneStatus(t.status) && !!t.resolution_id
}
