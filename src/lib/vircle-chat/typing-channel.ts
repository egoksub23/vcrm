// The ephemeral Realtime broadcast that carries "the user is typing" from the webhook
// (docs/vircle-chat-contract.md, section 3.4) to the agent's open Inbox thread. Shared by the
// server (which sends) and the browser (which listens), so it holds nothing else.

export const TYPING_EVENT = 'typing'

/** How long "typing..." stays up after the last signal (the contract says about 6 seconds). */
export const TYPING_DISPLAY_MS = 6000

export const typingChannelName = (conversationId: string) => `vircle-typing:${conversationId}`

/**
 * "typing..." that switches itself off: `signal()` shows it and (re)starts the countdown, `clear()`
 * hides it at once, `dispose()` drops the countdown without a final change (for unmounting).
 */
export function createTypingState(onChange: (typing: boolean) => void, ttlMs: number = TYPING_DISPLAY_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null
  const stop = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  return {
    signal() {
      stop()
      onChange(true)
      timer = setTimeout(() => {
        timer = null
        onChange(false)
      }, ttlMs)
    },
    clear() {
      stop()
      onChange(false)
    },
    dispose: stop,
  }
}
