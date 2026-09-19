import { createClient } from '@/lib/supabase/client';
import type { ConversationEvent } from '@/types';

/**
 * Closes a conversation with a required note — goes through the
 * `close_conversation_with_note` RPC (migration 065) rather than a plain
 * `.update()`, so the "a closure note is required" rule is enforced by
 * the DB CHECK constraint, not just by disabling a button client-side.
 */
export async function closeConversationWithNote(
  conversationId: string,
  note: string,
): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.rpc('close_conversation_with_note', {
    p_conversation_id: conversationId,
    p_note: note,
  });
  if (error) throw new Error(error.message);
}

/** Reopens a conversation — note optional, unlike closing. */
export async function reopenConversation(
  conversationId: string,
  note?: string,
): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.rpc('reopen_conversation', {
    p_conversation_id: conversationId,
    p_note: note ?? null,
  });
  if (error) throw new Error(error.message);
}

export async function fetchConversationEvents(
  conversationId: string,
): Promise<ConversationEvent[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('conversation_events')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data as ConversationEvent[]) ?? [];
}
