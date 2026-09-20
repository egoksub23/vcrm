import { createClient } from '@/lib/supabase/client'
import type { Ticket } from '@/types'
import { buildTicketPatch } from './patch'

/**
 * The one write path for tickets: the detail view, the board drag, the list's
 * inline edits and the bulk bar all come through here, so a status change
 * always carries its resolved_at / closed_at (see buildTicketPatch) and
 * everything is logged by the same DB triggers. Runs from the browser under
 * RLS, like every other ticket write. Resolves to the patch that was written
 * (so the caller can merge it into local state) or null when the write failed.
 */
export async function updateTickets(
  ids: string[],
  patch: Partial<Ticket>,
): Promise<Partial<Ticket> | null> {
  if (ids.length === 0) return {}
  const full = buildTicketPatch(patch)
  const { error } = await createClient().from('tickets').update(full).in('id', ids)
  if (error) {
    console.error('[updateTickets] failed:', error)
    return null
  }
  return full
}

export function updateTicket(id: string, patch: Partial<Ticket>): Promise<Partial<Ticket> | null> {
  return updateTickets([id], patch)
}
