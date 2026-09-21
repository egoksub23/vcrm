import type { SupabaseClient } from '@supabase/supabase-js';

import { isConversationLabel } from '@/lib/tags/scope';

export class ConversationLabelWriteError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = 'ConversationLabelWriteError';
    this.status = status;
  }
}

interface ConversationLabelWriteInput {
  accountId: string;
  conversationId: string;
  tagId: string;
  /** Set on inserts for the audit column; omitted on removes. */
  appliedByUserId?: string;
}

async function assertConversationAndTagOwnership(
  db: SupabaseClient,
  input: ConversationLabelWriteInput
): Promise<void> {
  const [conversationResult, tagResult] = await Promise.all([
    db
      .from('conversations')
      .select('id')
      .eq('id', input.conversationId)
      .eq('account_id', input.accountId)
      .maybeSingle(),
    db
      .from('tags')
      .select('id')
      .eq('id', input.tagId)
      .eq('account_id', input.accountId)
      // A soft-deleted tag (migration 082) no longer exists for callers that
      // bypass RLS with the service role; nor does one that still waits for a
      // reviewer (migration 084): it can never be applied.
      .is('deleted_at', null)
      .eq('approval_status', 'approved')
      .maybeSingle(),
  ]);

  if (conversationResult.error || tagResult.error) {
    throw new ConversationLabelWriteError(
      'Could not verify conversation label ownership'
    );
  }
  if (!conversationResult.data) {
    throw new ConversationLabelWriteError('Conversation not found', 404);
  }
  if (!tagResult.data) {
    throw new ConversationLabelWriteError('Tag not found', 404);
  }
}

/**
 * Add a label exactly once. The unique constraint on
 * (conversation_id, tag_id) is the concurrency-safe source of truth —
 * a duplicate insert is a no-op.
 */
export async function addConversationLabelIfAbsent(
  db: SupabaseClient,
  input: ConversationLabelWriteInput
): Promise<boolean> {
  await assertConversationAndTagOwnership(db, input);

  const { error } = await db
    .from('conversation_labels')
    .insert({
      conversation_id: input.conversationId,
      tag_id: input.tagId,
      applied_by: input.appliedByUserId ?? null,
    })
    .select('id')
    .maybeSingle();

  if (error?.code === '23505') return false;
  if (error) {
    throw new ConversationLabelWriteError(
      `Failed to add conversation label: ${error.message}`
    );
  }
  return true;
}

export async function removeConversationLabel(
  db: SupabaseClient,
  input: ConversationLabelWriteInput
): Promise<void> {
  await assertConversationAndTagOwnership(db, input);

  const { error } = await db
    .from('conversation_labels')
    .delete()
    .eq('conversation_id', input.conversationId)
    .eq('tag_id', input.tagId);

  if (error) {
    throw new ConversationLabelWriteError(
      `Failed to remove conversation label: ${error.message}`
    );
  }
}

/**
 * Manual (UI/API) guard: a conversation label must be a tag that is turned on
 * for conversations (migration 068 `for_conversations`). A contact-only tag is
 * rejected with a 400. It is intentionally NOT part of the shared write path,
 * so removing a label that was attached before this rule existed still works
 * and automation steps keep their current behaviour. A missing, deleted or
 * unapproved tag is left to `addConversationLabelIfAbsent`, which answers 404.
 */
export async function assertTagIsConversationLabel(
  db: SupabaseClient,
  input: { accountId: string; tagId: string }
): Promise<void> {
  const { data, error } = await db
    .from('tags')
    .select('id, for_conversations')
    .eq('id', input.tagId)
    .eq('account_id', input.accountId)
    .is('deleted_at', null)
    .eq('approval_status', 'approved')
    .maybeSingle();

  if (error) {
    throw new ConversationLabelWriteError('Could not verify the tag scope');
  }
  if (
    data &&
    !isConversationLabel({
      for_conversations:
        (data as { for_conversations?: boolean | null }).for_conversations ??
        undefined,
    })
  ) {
    throw new ConversationLabelWriteError(
      'This tag is for contacts only. Turn on "Conversations" for it in Settings > Tags, or pick a conversation label.',
      400
    );
  }
}
