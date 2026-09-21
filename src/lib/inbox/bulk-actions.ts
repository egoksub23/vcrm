import type { SupabaseClient } from '@supabase/supabase-js'
import type { Conversation } from '@/types'
import { closeConversationsWithNote } from '@/lib/conversations/session-log-api'

/**
 * Bulk inbox actions (multi-select → assign / close / mark read / mark
 * unread). Each goes through the same write paths the single-conversation
 * controls use — a plain RLS-scoped UPDATE (whose triggers log the
 * session event and send the assignment notification per row) or the
 * `close_conversation_with_note` RPC (run by the server) — so a bulk action
 * leaves exactly the audit trail N single actions would.
 */

export interface BulkResult {
  /** Ids whose write succeeded — the caller patches its local state for
   *  these only. */
  succeeded: string[]
  failed: number
}

type ConvRef = Pick<Conversation, 'id' | 'status' | 'unread_count'>

export async function bulkAssign(
  db: SupabaseClient,
  ids: string[],
  agentId: string | null,
): Promise<BulkResult> {
  if (ids.length === 0) return { succeeded: [], failed: 0 }
  const { error } = await db
    .from('conversations')
    .update({ assigned_agent_id: agentId })
    .in('id', ids)
  return error ? { succeeded: [], failed: ids.length } : { succeeded: ids, failed: 0 }
}

export async function bulkMarkRead(db: SupabaseClient, convs: ConvRef[]): Promise<BulkResult> {
  const ids = convs.filter((c) => c.unread_count > 0).map((c) => c.id)
  if (ids.length === 0) return { succeeded: [], failed: 0 }
  const { error } = await db.from('conversations').update({ unread_count: 0 }).in('id', ids)
  return error ? { succeeded: [], failed: ids.length } : { succeeded: ids, failed: 0 }
}

/** Marks read conversations unread (count 1). Already-unread ones are
 *  left alone rather than reset to 1. */
export async function bulkMarkUnread(db: SupabaseClient, convs: ConvRef[]): Promise<BulkResult> {
  const ids = convs.filter((c) => c.unread_count === 0).map((c) => c.id)
  if (ids.length === 0) return { succeeded: [], failed: 0 }
  const { error } = await db.from('conversations').update({ unread_count: 1 }).in('id', ids)
  return error ? { succeeded: [], failed: ids.length } : { succeeded: ids, failed: 0 }
}

/**
 * Close every not-yet-closed conversation with one shared note. The server
 * runs the per-conversation `close_conversation_with_note` RPC (the
 * closure-note rule lives in the database) and dispatches the
 * `conversation_closed` automations once per conversation, so one failure
 * doesn't stop the rest.
 */
export async function bulkClose(
  convs: ConvRef[],
  note: string,
  close: (
    ids: string[],
    note: string,
  ) => Promise<{ succeeded: string[]; failed: { id: string; error: string }[] }> = closeConversationsWithNote,
): Promise<BulkResult> {
  const ids = convs.filter((c) => c.status !== 'closed').map((c) => c.id)
  if (ids.length === 0) return { succeeded: [], failed: 0 }
  try {
    const res = await close(ids, note)
    return { succeeded: res.succeeded, failed: res.failed.length }
  } catch {
    return { succeeded: [], failed: ids.length }
  }
}
