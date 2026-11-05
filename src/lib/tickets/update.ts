import type { Ticket } from '@/types'

/** How a write ended. `code` says why it failed when the database gave a reason the screen can act on. */
export type UpdateResult =
  | { ok: true; patch: Partial<Ticket> }
  | { ok: false; code: 'resolution_required' | 'resolution_invalid' | 'other' }

/**
 * The one write path for tickets: the detail view, the board drag, the list's
 * inline edits and the bulk bar all come through here, so a status change
 * always carries its resolved_at / closed_at (see buildTicketPatch) and
 * everything is logged by the same DB triggers. Moving a ticket to Resolved or
 * Closed needs a resolution while the workspace requires one (migration 096):
 * the database refuses otherwise, and `code` then says `resolution_required`.
 */
export async function updateTicketsResult(ids: string[], patch: Partial<Ticket>): Promise<UpdateResult> {
  if (ids.length === 0) return { ok: true, patch: {} }
  const res = await fetch('/api/tickets/bulk', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, patch }),
  }).catch(() => null)
  if (!res) return { ok: false, code: 'other' }
  const json = (await res.json().catch(() => null)) as { ok?: boolean; patch?: Partial<Ticket>; code?: string } | null
  if (!res.ok || !json?.ok) {
    const code = (json?.code === 'resolution_required' || json?.code === 'resolution_invalid') ? json.code : 'other'
    return { ok: false, code }
  }
  return { ok: true, patch: json.patch ?? {} }
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
