interface ConversationLabelMutationResult {
  added?: boolean;
}

async function mutateConversationLabel(
  conversationId: string,
  tagId: string,
  method: 'POST' | 'DELETE'
): Promise<ConversationLabelMutationResult> {
  const response = await fetch(`/api/conversations/${conversationId}/labels`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_id: tagId }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
  } & ConversationLabelMutationResult;
  if (!response.ok) {
    throw new Error(body.error ?? 'Failed to update conversation label');
  }
  return body;
}

export function addConversationLabel(conversationId: string, tagId: string) {
  return mutateConversationLabel(conversationId, tagId, 'POST');
}

// Named "delete" (not "remove") to disambiguate from the server-side
// `removeConversationLabel` in `@/lib/conversations/label-write` —
// mirrors the addContactTag/deleteContactTag split in tag-api.ts.
export function deleteConversationLabel(conversationId: string, tagId: string) {
  return mutateConversationLabel(conversationId, tagId, 'DELETE');
}
