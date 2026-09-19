import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Re-open a closed conversation because the customer wrote again
 * (issue #409).
 *
 * Inbound processing bumps `unread_count` but used to leave `status`
 * alone, so a thread an agent closed — or that a `close_conversation`
 * automation step closed — stayed `closed` while accumulating unread
 * customer messages. It read as resolved, and it dropped out of the
 * inbox's Open filter, so an agent working that filter never saw the
 * reply. (Automation dispatch is unaffected either way: it keys on
 * account + trigger + contact, never conversation status.)
 *
 * Lives here rather than inline in the webhook so it can be tested
 * without standing up the whole route, and so any future inbound path
 * gets the same behaviour for free.
 */
export async function reopenClosedConversation(
  db: SupabaseClient,
  conversation: { id: string; status?: string | null },
): Promise<boolean> {
  // Nothing to do for open/pending threads, which is the common case —
  // skipping the round trip keeps inbound processing as cheap as it was.
  if (conversation.status !== 'closed') return false

  const { data, error } = await db
    .from('conversations')
    // closed_at (migration 050) reflects the CURRENT close, not
    // history — clearing it here means a later re-close starts a
    // fresh resolution-time measurement rather than inheriting this
    // one's timestamp.
    .update({ status: 'open', closed_at: null, updated_at: new Date().toISOString() })
    .eq('id', conversation.id)
    // Re-checked in SQL, not just in the `if` above: the caller's row was
    // read earlier in the request, so two concurrent inbound deliveries
    // both holding a stale `status: 'closed'` must not be able to write
    // 'open' back over an agent who re-closed the thread in between.
    .eq('status', 'closed')
    // Which rows actually flipped — a concurrent delivery may have
    // reopened it first, and only the one that did should log the event.
    .select('id')

  if (error) {
    // Best-effort, same as the conversation update this follows: a failed
    // re-open must not abort inbound processing (and make Meta redeliver).
    console.error('Error re-opening conversation:', error)
    return false
  }

  if (!data || data.length === 0) return false

  // Session log (migration 065): the reopen a customer's message causes
  // has no signed-in actor and doesn't go through reopen_conversation, so
  // record it here — otherwise the chat shows a conversation closed by X
  // that silently became open again. Best-effort like the update itself.
  const { error: logError } = await db.from('conversation_events').insert({
    conversation_id: conversation.id,
    event_type: 'reopened',
    actor_user_id: null,
    metadata: { reason: 'customer_message' },
  })
  if (logError) console.error('Error logging conversation reopen:', logError)

  return true
}
