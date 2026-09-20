import type { SupabaseClient } from '@supabase/supabase-js';

import type { Message } from '@/types';

export class CommentWriteError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = 'CommentWriteError';
    this.status = status;
  }
}

const COMMENT_MAX_LEN = 4000;

interface PostInternalCommentInput {
  accountId: string;
  conversationId: string;
  /** The author; null for a note the AI bot leaves (see `senderType`). */
  userId: string | null;
  text: string;
  /** Defaults to 'agent'. The AI bot's "answered from" note is 'bot'. */
  senderType?: 'agent' | 'bot';
  /** Knowledge articles the note points at (messages.kb_sources, migration 077). */
  kbSources?: { id: string; title: string }[];
  /** Mentioned user_ids — the `notify_message_mentions` DB trigger
   *  (migration 045) turns these into 'mention' notifications. */
  mentions?: string[];
}

/**
 * Post an internal comment — a `messages` row with `is_internal = true`
 * that the WhatsApp send path never touches. Used both by the composer's
 * "Comment" mode and by the agent-handoff-note flow, which posts one
 * right before reassigning a conversation.
 */
export async function postInternalComment(
  db: SupabaseClient,
  input: PostInternalCommentInput
): Promise<Message> {
  const text = input.text.trim();
  if (!text) {
    throw new CommentWriteError('Comment text is required', 400);
  }
  if (text.length > COMMENT_MAX_LEN) {
    throw new CommentWriteError(
      `Comment must be ${COMMENT_MAX_LEN} characters or fewer`,
      400
    );
  }

  const { data: conversation, error: convErr } = await db
    .from('conversations')
    .select('id')
    .eq('id', input.conversationId)
    .eq('account_id', input.accountId)
    .maybeSingle();
  if (convErr) {
    throw new CommentWriteError('Could not verify conversation ownership');
  }
  if (!conversation) {
    throw new CommentWriteError('Conversation not found', 404);
  }

  // Mentions are constrained to actual account members here too — the
  // DB trigger re-checks this (defense in depth), but failing fast
  // with a clear 400 beats a silently-dropped mention.
  const mentions = input.mentions ?? [];
  if (mentions.length > 0) {
    const { data: members, error: membersErr } = await db
      .from('profiles')
      .select('user_id')
      .eq('account_id', input.accountId)
      .in('user_id', mentions);
    if (membersErr) {
      throw new CommentWriteError('Could not verify mentioned teammates');
    }
    const validIds = new Set((members ?? []).map((m) => m.user_id));
    const invalid = mentions.filter((id) => !validIds.has(id));
    if (invalid.length > 0) {
      throw new CommentWriteError(
        'One or more mentioned users are not members of this account',
        400
      );
    }
  }

  const { data, error } = await db
    .from('messages')
    .insert({
      conversation_id: input.conversationId,
      sender_type: input.senderType ?? 'agent',
      sender_id: input.userId,
      content_type: 'text',
      content_text: text,
      status: 'sent',
      is_internal: true,
      mentions,
      ...(input.kbSources && input.kbSources.length > 0 ? { kb_sources: input.kbSources } : {}),
    })
    .select('*')
    .single();

  if (error || !data) {
    throw new CommentWriteError(`Failed to post comment: ${error?.message}`);
  }

  return data as Message;
}
