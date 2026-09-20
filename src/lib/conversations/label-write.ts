import type { SupabaseClient } from '@supabase/supabase-js';

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
      // bypass RLS with the service role.
      .is('deleted_at', null)
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
