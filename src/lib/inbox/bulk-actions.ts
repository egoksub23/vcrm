import type { Conversation } from '@/types'
import { closeConversationsWithNote } from '@/lib/conversations/session-log-api'

/**
 * Bulk inbox actions (multi-select → assign / close / mark read / mark
 * unread). Each goes through the same write paths the single-conversation
 * controls use — the server-side /api/conversations/bulk route applies RLS
 * and triggers exactly the audit trail N single actions would.
 */

export interface BulkResult {
  /** Ids whose write succeeded — the caller patches its local state for
   *  these only. */
  succeeded: string[]
  failed: number
}

type ConvRef = Pick<Conversation, 'id' | 'status' | 'unread_count'> & Partial<Pick<Conversation, 'last_channel_type'>>

async function bulkPost(body: object): Promise<BulkResult> {
  try {
    const res = await fetch('/api/conversations/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => ({}))
    return { succeeded: json.succeeded ?? [], failed: json.failed ?? 0 }
  } catch {
    return { succeeded: [], failed: 0 }
  }
}

export async function bulkAssign(
  ids: string[],
  agentId: string | null,
): Promise<BulkResult> {
  if (ids.length === 0) return { succeeded: [], failed: 0 }
  return bulkPost({ action: 'assign', ids, agentId })
}

export async function bulkMarkRead(convs: ConvRef[]): Promise<BulkResult> {
  if (convs.length === 0) return { succeeded: [], failed: 0 }
  return bulkPost({ action: 'markRead', convs })
}

/** Marks read conversations unread (count 1). Already-unread ones are
 *  left alone rather than reset to 1. */
export async function bulkMarkUnread(convs: ConvRef[]): Promise<BulkResult> {
  if (convs.length === 0) return { succeeded: [], failed: 0 }
  return bulkPost({ action: 'markUnread', convs })
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
