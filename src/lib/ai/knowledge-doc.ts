import { KB_LANGUAGES, type KbLanguage } from './knowledge-query'
import { kbHtmlToPlainText, sanitizeKbHtml } from '../knowledge-format'

// ============================================================
// Validation for knowledge-base article input (create / update).
// Pure, so the routes stay thin and the rules are testable.
// ============================================================

export const KB_KINDS = ['article', 'qa'] as const
export type KbKind = (typeof KB_KINDS)[number]
export const KB_STATUSES = ['draft', 'published'] as const
export type KbStatus = (typeof KB_STATUSES)[number]

export const MAX_TITLE_CHARS = 200
export const MAX_CONTENT_CHARS = 20000
/** Raw rich text accepted from a client, before it is sanitised. */
export const MAX_HTML_CHARS = 200000
const MAX_CATEGORY_CHARS = 60

export interface DocFields {
  title?: string
  content?: string
  /** Sanitised rich text; `content` is derived from it (null = plain-only). */
  content_html?: string | null
  collection_id?: string | null
  language?: KbLanguage
  kind?: KbKind
  status?: KbStatus
  use_in_ai?: boolean
  category?: string | null
  review_by?: string | null
  source_conversation_id?: string | null
}

export type ParsedDoc = { ok: true; fields: DocFields } | { ok: false; error: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v)

/**
 * Parse a request body into the fields to write. With `partial` set
 * (update) every field is optional but must be valid when present; for a
 * create, title and content are required.
 */
export function parseDocInput(body: unknown, opts: { partial: boolean }): ParsedDoc {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const fields: DocFields = {}

  if (b.title !== undefined) {
    if (typeof b.title !== 'string' || !b.title.trim()) return { ok: false, error: 'title cannot be empty' }
    if (b.title.trim().length > MAX_TITLE_CHARS) return { ok: false, error: `title is limited to ${MAX_TITLE_CHARS} characters` }
    fields.title = b.title.trim()
  }
  if (b.content !== undefined && typeof b.content_html !== 'string') {
    if (typeof b.content !== 'string' || !b.content.trim()) return { ok: false, error: 'content cannot be empty' }
    if (b.content.trim().length > MAX_CONTENT_CHARS) return { ok: false, error: `content is limited to ${MAX_CONTENT_CHARS} characters` }
    fields.content = b.content.trim()
  }
  if (b.content_html !== undefined) {
    if (b.content_html === null) fields.content_html = null
    else if (typeof b.content_html !== 'string') return { ok: false, error: 'content_html must be text' }
    else if (b.content_html.length > MAX_HTML_CHARS) {
      return { ok: false, error: 'The article is too long.' }
    } else {
      // Sanitise on the server whatever the editor sent, and derive the
      // plain text search and the AI read from the result — a client's own
      // `content` is ignored when it sends rich text.
      const html = sanitizeKbHtml(b.content_html)
      const plain = kbHtmlToPlainText(html)
      if (!plain.trim()) return { ok: false, error: 'content cannot be empty' }
      if (plain.length > MAX_CONTENT_CHARS) {
        return { ok: false, error: `content is limited to ${MAX_CONTENT_CHARS} characters` }
      }
      fields.content_html = html
      fields.content = plain
    }
  }
  if (b.collection_id !== undefined) {
    if (b.collection_id === null || b.collection_id === '') fields.collection_id = null
    else if (typeof b.collection_id !== 'string' || !UUID.test(b.collection_id)) {
      return { ok: false, error: 'collection_id must be a collection id' }
    } else fields.collection_id = b.collection_id
  }
  if (b.language !== undefined) {
    if (!isOneOf(KB_LANGUAGES, b.language)) return { ok: false, error: 'language must be en, ms or zh' }
    fields.language = b.language
  }
  if (b.kind !== undefined) {
    if (!isOneOf(KB_KINDS, b.kind)) return { ok: false, error: 'kind must be article or qa' }
    fields.kind = b.kind
  }
  if (b.status !== undefined) {
    if (!isOneOf(KB_STATUSES, b.status)) return { ok: false, error: 'status must be draft or published' }
    fields.status = b.status
  }
  if (b.use_in_ai !== undefined) {
    if (typeof b.use_in_ai !== 'boolean') return { ok: false, error: 'use_in_ai must be true or false' }
    fields.use_in_ai = b.use_in_ai
  }
  if (b.category !== undefined) {
    if (b.category === null || b.category === '') fields.category = null
    else if (typeof b.category !== 'string') return { ok: false, error: 'category must be text' }
    else fields.category = b.category.trim().slice(0, MAX_CATEGORY_CHARS) || null
  }
  if (b.review_by !== undefined) {
    if (b.review_by === null || b.review_by === '') fields.review_by = null
    else if (typeof b.review_by !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.review_by)) {
      return { ok: false, error: 'review_by must be a date (YYYY-MM-DD)' }
    } else fields.review_by = b.review_by
  }
  if (b.source_conversation_id !== undefined) {
    if (b.source_conversation_id === null) fields.source_conversation_id = null
    else if (
      typeof b.source_conversation_id !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(b.source_conversation_id)
    ) {
      return { ok: false, error: 'source_conversation_id must be a conversation id' }
    } else fields.source_conversation_id = b.source_conversation_id
  }

  if (!opts.partial && (!fields.title || !fields.content)) {
    return { ok: false, error: 'title and content are required' }
  }
  if (opts.partial && Object.keys(fields).length === 0) {
    return { ok: false, error: 'Nothing to update' }
  }
  return { ok: true, fields }
}
