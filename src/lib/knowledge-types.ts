import type { KbLanguage } from '@/lib/ai/knowledge-query'
import type { KbKind, KbStatus } from '@/lib/ai/knowledge-doc'

/** One row of the knowledge library (GET /api/knowledge). */
export interface KnowledgeDocSummary {
  id: string
  title: string
  kind: KbKind
  language: KbLanguage
  status: KbStatus
  use_in_ai: boolean
  category: string | null
  review_by: string | null
  updated_at: string
  created_by: string | null
  source_conversation_id: string | null
  /** Times the AI used it in the last 30 days. */
  ai_uses: number
}

/** One search result (GET /api/knowledge/search). */
export interface KnowledgeSearchResult {
  id: string
  title: string
  category: string | null
  language: KbLanguage
  kind: KbKind
  use_in_ai: boolean
  snippet: string
  /** The whole article, up to 4,000 characters — what "Insert" pastes. */
  body: string
  via: 'meaning' | 'keyword'
}

/** Pre-filled values for the article dialog (from a chat, a gap…). */
export interface ArticleDraftSeed {
  title?: string
  content?: string
  language?: KbLanguage
  kind?: KbKind
  sourceConversationId?: string | null
  /** Set when the article answers an unanswered question. */
  resolvesGapId?: string
}
