import type { SupabaseClient } from '@supabase/supabase-js'
import { postInternalComment } from '@/lib/conversations/comment-write'

// ============================================================
// After the AI answers from the knowledge base it leaves an internal note in
// the conversation: "AI answered from: Business hours, Refunds". Internal
// notes never reach the customer (the send path ignores them); teammates see
// it with links to the articles (the ids travel in messages.kb_sources).
// ============================================================

export interface SourceRef {
  id: string
  title: string
}

const MAX_SOURCES = 5
const MAX_TITLE_CHARS = 80

export function sourcesNoteText(sources: SourceRef[]): string {
  const titles = sources.slice(0, MAX_SOURCES).map((s) => {
    const t = s.title.replace(/\s+/g, ' ').trim()
    return t.length > MAX_TITLE_CHARS ? `${t.slice(0, MAX_TITLE_CHARS - 1)}…` : t
  })
  return `AI answered from: ${titles.join(', ')}`
}

/** Best-effort: a failed note must never affect the reply the customer got. */
export async function postSourcesNote(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  sources: SourceRef[],
): Promise<void> {
  if (sources.length === 0) return
  try {
    await postInternalComment(db, {
      accountId,
      conversationId,
      userId: null,
      senderType: 'bot',
      text: sourcesNoteText(sources),
      kbSources: sources.slice(0, MAX_SOURCES).map((s) => ({ id: s.id, title: s.title })),
    })
  } catch (err) {
    console.error('[knowledge] sources note failed:', err)
  }
}
