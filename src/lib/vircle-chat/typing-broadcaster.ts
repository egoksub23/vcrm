// In-process pub/sub for the "user is typing" SSE stream. Works within a
// single Node.js process — sufficient for the single-container deployment.
// To scale horizontally, swap this module for a Redis pub/sub adapter
// without changing any call sites.

type SendFn = (data: object) => void;

const subscribers = new Map<string, Set<SendFn>>();

/** Register a send function for a conversation. Returns an unsubscribe function. */
export function subscribeToTyping(
  conversationId: string,
  send: SendFn,
): () => void {
  if (!subscribers.has(conversationId)) {
    subscribers.set(conversationId, new Set());
  }
  subscribers.get(conversationId)!.add(send);
  return () => {
    const subs = subscribers.get(conversationId);
    if (!subs) return;
    subs.delete(send);
    if (subs.size === 0) subscribers.delete(conversationId);
  };
}

/** Push a typing payload to every open SSE connection for this conversation.
 *  Silently drops connections that have already closed. */
export function broadcastTyping(conversationId: string, data: object): void {
  const subs = subscribers.get(conversationId);
  if (!subs) return;
  for (const send of subs) {
    try {
      send(data);
    } catch {
      // Connection closed before the abort event fired — ignore.
    }
  }
}
