import type { KbLanguage } from '@/lib/ai/knowledge-query'
import type { KbKind, KbStatus } from '@/lib/ai/knowledge-doc'

// ============================================================
// Shared contract for the knowledge base: the API payloads the library,
// the article editor, the chat panel and the AI all agree on.
// ============================================================

export type KbAttachmentKind = 'image' | 'video' | 'audio' | 'document'

/** A collection: a simple folder of articles (design: "Collections"). */
export interface KnowledgeCollection {
  id: string
  name: string
  /** Hex colour, e.g. "#7C3AED". */
  color: string
  sort_order: number
  /** Filled by GET /api/knowledge. */
  article_count?: number
}

/** A file attached to an article. It travels with the answer: an agent
 *  inserting the article, or the AI answering from it, sends the files too. */
export interface KnowledgeAttachment {
  id: string
  document_id: string
  file_name: string
  mime_type: string
  size_bytes: number
  kind: KbAttachmentKind
  /** Public URL (chat-media bucket) that Meta / mail providers can fetch. */
  url: string
  /** Object path inside the chat-media bucket, e.g. account-<id>/kb/….pdf */
  storage_path: string
  /** When the AI answers from this article, send this file with the reply. */
  send_with_ai: boolean
  position: number
}

/** An attachment as the editor sends it on save. `id` present = keep it
 *  (its `send_with_ai` may change); absent = a newly uploaded file. Any
 *  existing attachment missing from the list is removed. */
export interface StagedKnowledgeAttachment {
  id?: string
  file_name: string
  mime_type: string
  size_bytes: number
  url: string
  storage_path: string
  send_with_ai: boolean
}

/** One row of the knowledge library (GET /api/knowledge). */
export interface KnowledgeDocSummary {
  id: string
  title: string
  kind: KbKind
  language: KbLanguage
  status: KbStatus
  use_in_ai: boolean
  /** Collection name (kept in sync with `collection_id`); null = none. */
  category: string | null
  collection_id: string | null
  review_by: string | null
  updated_at: string
  created_by: string | null
  source_conversation_id: string | null
  /** 'file' | 'url' when the article was imported; null when written by hand. */
  source_kind: 'file' | 'url' | null
  /** Times the AI used it in the last 30 days. */
  ai_uses: number
  attachment_count: number
}

/** GET /api/knowledge */
export interface KnowledgeLibraryResponse {
  documents: KnowledgeDocSummary[]
  collections: KnowledgeCollection[]
  search_mode: 'meaning' | 'keyword'
  use_window_days: number
  open_gaps: number
  /** Answers the AI gave using the knowledge base in the last 30 days. */
  ai_answers_30d: number
}

/** GET /api/knowledge/[id] — the whole article. */
export interface KnowledgeArticle {
  id: string
  title: string
  /** Plain text: what search and the AI read (derived from content_html). */
  content: string
  /** Rich text as written in the editor; null for older plain-text articles. */
  content_html: string | null
  kind: KbKind
  language: KbLanguage
  status: KbStatus
  use_in_ai: boolean
  category: string | null
  collection_id: string | null
  review_by: string | null
  updated_at: string
  created_by: string | null
  source_conversation_id: string | null
  source_kind: 'file' | 'url' | null
  source_url: string | null
  attachments: KnowledgeAttachment[]
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
  /** The whole article as plain text, up to 4,000 characters. */
  body: string
  /** The rich version when the article has one (used for email replies). */
  body_html: string | null
  via: 'meaning' | 'keyword'
  attachments: KnowledgeAttachment[]
}

/** POST /api/knowledge/test — what the AI would see for a question. */
export interface KnowledgeTestPassage {
  document_id: string
  title: string
  text: string
  score: number
  /** true = would be sent to the AI; false = under the relevance cut-off. */
  used: boolean
  via: 'meaning' | 'keyword'
}
export interface KnowledgeTestResponse {
  passages: KnowledgeTestPassage[]
  mode: 'meaning' | 'keyword'
  /** Human-readable cut-off note, e.g. "0.62 (meaning) / keyword coverage". */
  cutoff_note: string
}

/** GET /api/knowledge/[id]/versions */
export interface KnowledgeVersion {
  id: string
  title: string
  edited_by: string | null
  edited_by_name: string | null
  created_at: string
}

/** GET /api/knowledge/insights */
export interface KnowledgeInsights {
  window_days: number
  most_used: { id: string; title: string; uses: number }[]
  never_used: { id: string; title: string; updated_at: string }[]
  /** Articles written to answer an unanswered question, with the number of
   *  handoffs each one closed. */
  handoff_fixes: { id: string; title: string; handoffs: number }[]
}

/** A source the AI used (POST /api/ai/draft returns these as `sources`). */
export interface KnowledgeSource {
  id: string
  title: string
  /** 1-based number the model cited it by. */
  n: number
}

/** Pre-filled values for the article editor (from a chat, a gap…). */
export interface ArticleDraftSeed {
  title?: string
  content?: string
  language?: KbLanguage
  kind?: KbKind
  sourceConversationId?: string | null
  /** Set when the article answers an unanswered question. */
  resolvesGapId?: string
}

/** How big / what type an attachment may be. Any file type is accepted; the
 *  size caps follow WhatsApp's (image 5 MB, everything else 16 MB). */
export const KB_ATTACHMENT_MAX_BYTES = { image: 5 * 1024 * 1024, other: 16 * 1024 * 1024 } as const
export const KB_MAX_ATTACHMENTS = 10

export function attachmentKindFor(mime: string): KbAttachmentKind {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'document'
}

/** An article an AI reply was based on, as stored on the internal "AI answered
 *  from" note (`messages.kb_sources`). */
export interface MessageKbSource {
  id: string
  title: string
}
