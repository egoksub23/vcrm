// ============================================================
// "Save agent reply": after the AI handed a question to a human, the first
// thing the human wrote back is a ready draft for a new article.
// ============================================================

export interface ThreadMessage {
  sender_type: string
  content_type: string
  content_text: string | null
  is_internal: boolean | null
  created_at: string
}

/** The first written reply from a human agent after `after` (the moment the AI
 *  handed the question over). Bot replies, internal notes, customer messages
 *  and media without text are skipped. */
export function pickAgentReply(messages: ThreadMessage[], after: string): string | null {
  const from = Date.parse(after)
  const ordered = [...messages].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
  for (const m of ordered) {
    if (Date.parse(m.created_at) <= from) continue
    if (m.sender_type !== 'agent' || m.is_internal) continue
    if (m.content_type !== 'text') continue
    const text = (m.content_text ?? '').trim()
    if (text) return text
  }
  return null
}
