import { createClient } from '@/lib/supabase/client'
import type { Ticket } from '@/types'
import { buildTicketPatch } from './patch'
import { resolutionErrorCode } from './resolution'

/** How a write ended. `code` says why it failed when the database gave a reason the screen can act on. */
export type UpdateResult =
  | { ok: true; patch: Partial<Ticket> }
  | { ok: false; code: 'resolution_required' | 'resolution_invalid' | 'other' }

/**
 * The one write path for tickets: the detail view, the board drag, the list's
 * inline edits and the bulk bar all come through here, so a status change
 * always carries its resolved_at / closed_at (see buildTicketPatch) and
 * everything is logged by the same DB triggers. Runs from the browser under
 * RLS, like every other ticket write. Moving a ticket to Resolved or Closed
 * needs a resolution while the workspace requires one (migration 096): the
 * database refuses otherwise, and `code` then says `resolution_required`.
 */
export async function updateTicketsResult(ids: string[], patch: Partial<Ticket>): Promise<UpdateResult> {
  if (ids.length === 0) return { ok: true, patch: {} }
  const full = buildTicketPatch(patch)
  const { error } = await createClient().from('tickets').update(full).in('id', ids)
  if (error) {
    console.error('[updateTickets] failed:', error)
    return { ok: false, code: resolutionErrorCode(error) ?? 'other' }
  }
  return { ok: true, patch: full }
}

export function updateTicketResult(id: string, patch: Partial<Ticket>): Promise<UpdateResult> {
  return updateTicketsResult([id], patch)
}

/** Resolves to the patch that was written (so the caller can merge it into local state) or null when the write failed. */
export async function updateTickets(
  ids: string[],
  patch: Partial<Ticket>,
): Promise<Partial<Ticket> | null> {
  const r = await updateTicketsResult(ids, patch)
  return r.ok ? r.patch : null
}

export function updateTicket(id: string, patch: Partial<Ticket>): Promise<Partial<Ticket> | null> {
  return updateTickets([id], patch)
}
