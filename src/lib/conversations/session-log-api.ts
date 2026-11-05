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
  const res = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/reopen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: note ?? null }),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(json?.error ?? 'Failed to reopen conversation');
  }
}

export async function fetchConversationEvents(
  conversationId: string,
): Promise<ConversationEvent[]> {
  const res = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/events`);
  if (!res.ok) throw new Error('Failed to fetch conversation events');
  const json = (await res.json()) as { events?: ConversationEvent[] };
  return json.events ?? [];
}
