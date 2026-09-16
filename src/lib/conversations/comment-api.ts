import type { Message } from '@/types';

/** Post an internal comment (never sent to WhatsApp) from the client. */
export async function postComment(
  conversationId: string,
  text: string,
  mentions: string[] = []
): Promise<Message> {
  const response = await fetch(`/api/conversations/${conversationId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, mentions }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    message?: Message;
  };
  if (!response.ok || !body.message) {
    throw new Error(body.error ?? 'Failed to post comment');
  }
  return body.message;
}
