import type { SupabaseClient } from '@supabase/supabase-js';

import {
  runAutomationsForTrigger,
  type AutomationContext,
} from '@/lib/automations/engine';
import { MAX_TAG_CHAIN_DEPTH, getTagChainDepth } from '@/lib/contacts/tag-chain';
import { addConversationLabelIfAbsent } from './label-write';

interface AddConversationLabelAndDispatchInput {
  db: SupabaseClient;
  accountId: string;
  conversationId: string;
  tagId: string;
  appliedByUserId?: string;
  context?: AutomationContext;
}

export interface AddConversationLabelResult {
  added: boolean;
  dispatched: boolean;
  reason?: 'duplicate' | 'max_depth';
}

/**
 * Central server-side conversation-label writer for the manual (UI/API)
 * path. Mirrors addContactTagAndDispatch in @/lib/contacts/tag-events —
 * dispatches conversation_label_added only for a newly-created join, and
 * caps chained label automations with the same shared budget tag_added
 * uses, so a tag_added -> add_conversation_label -> conversation_label_added
 * chain can't loop forever either.
 */
export async function addConversationLabelAndDispatch(
  input: AddConversationLabelAndDispatchInput
): Promise<AddConversationLabelResult> {
  const added = await addConversationLabelIfAbsent(input.db, {
    accountId: input.accountId,
    conversationId: input.conversationId,
    tagId: input.tagId,
    appliedByUserId: input.appliedByUserId,
  });

  if (!added) return { added: false, dispatched: false, reason: 'duplicate' };

  const depth = getTagChainDepth(input.context);
  if (depth >= MAX_TAG_CHAIN_DEPTH) {
    console.warn('[automations] conversation_label_added chain depth limit reached', {
      accountId: input.accountId,
      conversationId: input.conversationId,
      tagId: input.tagId,
      depth,
    });
    return { added: true, dispatched: false, reason: 'max_depth' };
  }

  const { data: conversation } = await input.db
    .from('conversations')
    .select('contact_id')
    .eq('id', input.conversationId)
    .eq('account_id', input.accountId)
    .maybeSingle();

  await runAutomationsForTrigger({
    accountId: input.accountId,
    triggerType: 'conversation_label_added',
    contactId: (conversation?.contact_id as string | undefined) ?? null,
    context: {
      ...input.context,
      conversation_id: input.conversationId,
      tag_id: input.tagId,
      vars: {
        ...(input.context?.vars ?? {}),
        _tag_chain_depth: depth + 1,
      },
    },
  });

  return { added: true, dispatched: true };
}
