// Browser-side calls to Halo's own Vircle Chat routes from the Inbox. Both are fire-and-forget:
// a "read" tick or a "typing..." that does not arrive is never worth interrupting an agent for.

const post = (path: string, conversationId: string): void => {
  fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId }),
  }).catch(() => {
    // Swallowed on purpose: see the note above.
  })
}

/** Tell the app the agent has read this conversation's messages (`POST /api/vircle-chat/read`). */
export function notifyVircleRead(conversationId: string): void {
  post('/api/vircle-chat/read', conversationId)
}

/** Show "typing..." to the user in the app (`POST /api/vircle-chat/typing`); the server throttles it too. */
export function notifyVircleTyping(conversationId: string): void {
  post('/api/vircle-chat/typing', conversationId)
}

/** The composer sends a typing signal at most this often (the server enforces the same interval). */
export const TYPING_SEND_INTERVAL_MS = 3000

/**
 * Wrap `send` so it runs at most once per `intervalMs`, however often the returned function is
 * called (the composer calls it on every keystroke). The first call goes through at once.
 */
export function throttled(send: () => void, intervalMs: number = TYPING_SEND_INTERVAL_MS, now: () => number = Date.now) {
  let last = -Infinity
  return () => {
    const t = now()
    if (t - last < intervalMs) return
    last = t
    send()
  }
}
