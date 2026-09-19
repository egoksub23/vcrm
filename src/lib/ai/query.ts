import type { ChatMessage } from './types'

/**
 * The text to retrieve knowledge against: the most recent customer
 * (`user`) turn in the conversation context. Falls back to the last
 * message of any role, then empty string. Shared by the draft route and
 * the auto-reply bot so both query the knowledge base the same way.
 */
export function latestUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content
  }
  return messages.length > 0 ? messages[messages.length - 1].content : ''
}

/** Longest run of recent customer text used as the search question. */
const MAX_QUERY_CHARS = 500
const MAX_QUERY_TURNS = 3

/**
 * The search question for the knowledge base: the customer's last few
 * messages, oldest first, up to ~500 characters. A follow-up like "and
 * how much yearly?" only makes sense next to the message before it, so
 * searching on the latest turn alone finds nothing useful.
 */
export function recentCustomerText(messages: ChatMessage[]): string {
  const picked: string[] = []
  let chars = 0
  for (let i = messages.length - 1; i >= 0 && picked.length < MAX_QUERY_TURNS; i--) {
    if (messages[i].role !== 'user') continue
    const text = messages[i].content.trim()
    if (!text) continue
    if (picked.length > 0 && chars + text.length > MAX_QUERY_CHARS) break
    picked.unshift(text.slice(0, MAX_QUERY_CHARS))
    chars += text.length
  }
  return picked.join('\n')
}
