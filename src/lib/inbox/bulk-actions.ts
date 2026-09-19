import type { SupabaseClient } from '@supabase/supabase-js'
import type { Conversation } from '@/types'

/**
 * Bulk inbox actions (multi-select → assign / close / mark read / mark
 * unread). Each goes through the same write paths the single-conversation
 * controls use — a plain RLS-scoped UPDATE (whose triggers log the
 * session event and send the assignment notification per row) or the
 * `close_conversation_with_note` RPC — so a bulk action leaves exactly the
 * audit trail N single actions would.
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
 * Close every not-yet-closed conversation with one shared note. Uses the
 * per-conversation RPC (the closure-note rule lives in the database), so
 * one failure doesn't stop the rest.
 */
export async function bulkClose(
  db: SupabaseClient,
  convs: ConvRef[],
  note: string,
): Promise<BulkResult> {
  const ids = convs.filter((c) => c.status !== 'closed').map((c) => c.id)
  const results = await Promise.allSettled(
    ids.map((id) =>
      db
        .rpc('close_conversation_with_note', { p_conversation_id: id, p_note: note })
        .then(({ error }) => {
          if (error) throw error
        }),
    ),
  )
  const succeeded: string[] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') succeeded.push(ids[i])
  })
  return { succeeded, failed: ids.length - succeeded.length }
}
