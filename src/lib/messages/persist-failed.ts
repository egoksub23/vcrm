// ============================================================
// Persist a failed send as a `status:'failed'` messages row — the
// shared core `sendMessageToConversation()`'s own `failSend()` uses,
// lifted out so the automations and Flows send paths (which have their
// own hand-rolled Meta calls, not routed through the shared core) can
// leave the same visible trace instead of letting a send failure
// vanish into an automation/flow run log nobody looking at the
// conversation would think to check.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { failureFromError } from './failure-reason';

/**
 * Insert a `messages` row. If the database has not had migration 094
 * yet (no `send_payload` column), retry without it rather than losing
 * the message.
 */
export async function insertMessageRowCompat(
  db: SupabaseClient,
  row: Record<string, unknown>,
): Promise<{ data: { id: string } | null; error: { message: string } | null }> {
  const first = await db.from('messages').insert(row).select().single();
  if (first.error && 'send_payload' in row && /send_payload/i.test(first.error.message ?? '')) {
    const { send_payload: _dropped, ...rest } = row;
    void _dropped;
    return db.from('messages').insert(rest).select().single();
  }
  return first as { data: { id: string } | null; error: { message: string } | null };
}

/**
 * Save what was attempted as a `failed` bubble carrying the reason, so
 * it stays in the chat and can be resent, and flag the conversation as
 * "not sent" — only that flag; `last_message_text`/`last_message_at`,
 * `unread_count` and the awaiting-response state are deliberately left
 * untouched, so a message that did not go out never reads as a reply
 * (mirrors `sendMessageToConversation`'s own `failSend()` comment).
 * Best-effort throughout: a logging failure here must never block the
 * caller's own error handling, so this never throws.
 */
export async function insertFailedMessageRow(
  db: SupabaseClient,
  row: Record<string, unknown> & { conversation_id: string },
  cause: unknown,
): Promise<string | null> {
  const failure = failureFromError(cause);
  try {
    const { data, error } = await insertMessageRowCompat(db, {
      ...row,
      message_id: null,
      status: 'failed',
      error_code: failure.code,
      error_title: failure.title,
      error_details: failure.details,
    });
    if (error) {
      console.error('[persist-failed] could not save the failed message:', error.message);
      return null;
    }
    const failedMessageId = data?.id ?? null;
    const { error: convErr } = await db
      .from('conversations')
      .update({ last_message_failed: true })
      .eq('id', row.conversation_id);
    if (convErr) {
      console.error('[persist-failed] could not flag the conversation as not-sent:', convErr.message);
    }
    return failedMessageId;
  } catch (err) {
    console.error(
      '[persist-failed] could not save the failed message:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
