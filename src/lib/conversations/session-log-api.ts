import { createClient } from '@/lib/supabase/client';
import type { ConversationEvent } from '@/types';

/**
 * Closes conversations with a required note. Goes to the server
 * (`POST /api/conversations/close`), which runs the
 * `close_conversation_with_note` RPC (migration 065, so the "a closure note is
 * required" rule is enforced by the database, not just by disabling a button)
 * and then dispatches the `conversation_closed` automations, once.
 */
export async function closeConversationsWithNote(
  conversationIds: string[],
  note: string,
): Promise<{ succeeded: string[]; failed: { id: string; error: string }[] }> {
  const res = await fetch('/api/conversations/close', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversation_ids: conversationIds, note }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    succeeded?: string[];
    failed?: { id: string; error: string }[];
    error?: string;
  };
  if (!res.ok && !body.failed) throw new Error(body.error ?? 'Failed to close the conversation');
  return { succeeded: body.succeeded ?? [], failed: body.failed ?? [] };
}

export async function closeConversationWithNote(
  conversationId: string,
  note: string,
): Promise<void> {
  const { failed } = await closeConversationsWithNote([conversationId], note);
  if (failed.length > 0) throw new Error(failed[0].error);
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
