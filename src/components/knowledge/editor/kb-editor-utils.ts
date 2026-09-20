import type { KbLanguage } from '@/lib/ai/knowledge-query'
import { KB_LANGUAGES } from '@/lib/ai/knowledge-query'
import { KB_KINDS, type KbKind, type KbStatus } from '@/lib/ai/knowledge-doc'
import { listKbImages } from '@/lib/knowledge-format'
import { orderForDocument } from '@/lib/knowledge/inline-images'
import {
  KB_ATTACHMENT_MAX_BYTES,
  KB_MAX_ATTACHMENTS,
  type ArticleDraftSeed,
  type StagedKnowledgeAttachment,
} from '@/lib/knowledge-types'

// Pure helpers behind the article editor, kept out of the components so they
// can be tested without a DOM.

/** "1.4 MB", "820 KB", "12 B". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  const mb = bytes / (1024 * 1024)
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`
}

export type FileVisual = 'image' | 'pdf' | 'word' | 'slides' | 'sheet' | 'video' | 'audio' | 'archive' | 'text' | 'other'

/** Which icon a file gets in the attachment list. The extension is a
 *  fallback because browsers report an empty MIME type for some files. */
export function fileVisual(mime: string, fileName: string): FileVisual {
  const m = (mime || '').toLowerCase()
  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : ''
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (m.includes('wordprocessingml') || m === 'application/msword' || ext === 'doc' || ext === 'docx') return 'word'
  if (m.includes('presentationml') || m === 'application/vnd.ms-powerpoint' || ext === 'ppt' || ext === 'pptx') return 'slides'
  if (m.includes('spreadsheetml') || m === 'application/vnd.ms-excel' || m === 'text/csv' || ext === 'xls' || ext === 'xlsx' || ext === 'csv') return 'sheet'
  if (m.includes('zip') || m.includes('compressed') || ext === 'zip' || ext === 'rar' || ext === '7z') return 'archive'
  if (m.startsWith('text/') || ext === 'txt' || ext === 'md') return 'text'
  return 'other'
}

export type AttachmentRejection =
  | { reason: 'tooMany'; max: number }
  | { reason: 'tooLarge'; maxBytes: number }

/** Client-side gate before an upload starts. The server checks again; this
 *  just avoids uploading a file that will be refused. */
export function checkAttachmentFile(
  file: { type: string; size: number },
  currentCount: number,
): AttachmentRejection | null {
  if (currentCount >= KB_MAX_ATTACHMENTS) return { reason: 'tooMany', max: KB_MAX_ATTACHMENTS }
  const maxBytes = file.type.startsWith('image/') ? KB_ATTACHMENT_MAX_BYTES.image : KB_ATTACHMENT_MAX_BYTES.other
  if (file.size > maxBytes) return { reason: 'tooLarge', maxBytes }
  return null
}

/** A file in the editor's attachment list. `id` is set once the server has
 *  stored it; a row with no `id` is a fresh upload that has not been saved. */
export interface AttachmentRow {
  /** Client-only key for React; the server id when there is one. */
  key: string
  id?: string
  file_name: string
  mime_type: string
  size_bytes: number
  url: string
  storage_path: string
  send_with_ai: boolean
  status: 'uploading' | 'ready' | 'error'
  error?: string
  /** An image shown inside the article body (an <img> in the text). */
  inline?: boolean
  /** The image's caption (the editor keeps the text's `alt` in step with it). */
  caption?: string | null
  /** A local picture shown while an in-article image uploads. Never sent. */
  preview?: string
}

/** The images of the article body, in document order. */
function bodyImages(html: string) {
  return listKbImages(html)
}

/** Inline images the body no longer shows (the person deleted the image in the
 *  text). They are dropped from the list on save, which removes the file. */
export function inlineRowsMissingFromHtml(rows: AttachmentRow[], html: string): AttachmentRow[] {
  const shown = new Set(bodyImages(html).map((i) => i.src))
  return rows.filter((r) => r.inline && r.status === 'ready' && !shown.has(r.url))
}

/**
 * The rows to send on save: only files that finished uploading. Given the
 * article's `html`, an inline image the text no longer shows is left out (so
 * it is removed), each shown one takes its caption from the text's `alt`, and
 * the list is put in document order: inline images as they appear, then the
 * other files. That order is the order they are sent in.
 */
export function stagedAttachments(rows: AttachmentRow[], html?: string): StagedKnowledgeAttachment[] {
  let list = rows.filter((r) => r.status === 'ready')
  if (html !== undefined) {
    const images = bodyImages(html)
    const gone = new Set(inlineRowsMissingFromHtml(list, html).map((r) => r.key))
    const altOf = new Map<string, string>()
    for (const img of images) if (!altOf.has(img.src)) altOf.set(img.src, img.alt)
    list = list
      .filter((r) => !gone.has(r.key))
      .map((r) => (r.inline && altOf.has(r.url) ? { ...r, caption: altOf.get(r.url) || null } : r))
    list = orderForDocument(
      list,
      images.map((i) => i.src),
      (r) => r.url,
    )
  }
  return list.map((r) => ({
    ...(r.id ? { id: r.id } : {}),
    file_name: r.file_name,
    mime_type: r.mime_type || 'application/octet-stream',
    size_bytes: r.size_bytes,
    url: r.url,
    storage_path: r.storage_path,
    send_with_ai: r.send_with_ai,
    ...(r.inline !== undefined ? { inline: r.inline } : {}),
    ...(r.caption !== undefined ? { caption: r.caption } : {}),
  }))
}

/** Uploads that were never saved, so they can be deleted when the editor
 *  is abandoned or the file is removed. */
export function unsavedUploads(rows: AttachmentRow[]): AttachmentRow[] {
  return rows.filter((r) => !r.id && r.status === 'ready' && r.storage_path)
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Plain text to editor HTML: blank lines split paragraphs, single newlines
 *  become line breaks. Old articles have no HTML, so they open this way. */
export function plainTextToEditorHtml(text: string): string {
  const normalised = text.replace(/\r\n?/g, '\n').trim()
  if (!normalised) return ''
  return normalised
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

/** Read the deep-link query of /knowledge/new. Unknown or invalid values
 *  are dropped rather than trusted. */
export function parseSeedParams(get: (key: string) => string | null): ArticleDraftSeed {
  const seed: ArticleDraftSeed = {}
  const title = get('title')
  if (title?.trim()) seed.title = title.trim()
  const content = get('content')
  if (content?.trim()) seed.content = content
  const language = get('language')
  if (language && (KB_LANGUAGES as readonly string[]).includes(language)) seed.language = language as KbLanguage
  const kind = get('kind')
  if (kind && (KB_KINDS as readonly string[]).includes(kind)) seed.kind = kind as KbKind
  const conv = get('conv')
  if (conv) seed.sourceConversationId = conv
  const gap = get('gap')
  if (gap) seed.resolvesGapId = gap
  return seed
}

/** May this person change this article? Mirrors the server: admins edit
 *  anything, agents only their own drafts. */
export function canEditArticle(input: {
  isAdmin: boolean
  canWrite: boolean
  userId: string | null
  article: { status: KbStatus; created_by: string | null } | null
}): boolean {
  if (input.isAdmin) return true
  if (!input.canWrite) return false
  if (!input.article) return true
  return input.article.status === 'draft' && !!input.userId && input.article.created_by === input.userId
}

export interface SavePayloadInput {
  title: string
  html: string
  text: string
  kind: KbKind
  language: KbLanguage
  useInAi: boolean
  collectionId: string | null
  reviewBy: string
  /** Only admins choose a status; agents' drafts omit it. */
  status: KbStatus | null
  sourceConversationId?: string | null
  attachments: AttachmentRow[]
}

/** The JSON body for POST / PATCH /api/knowledge. `content` is sent too so a
 *  server that has not learned `content_html` yet still validates; a newer
 *  server derives its own plain text from the sanitised HTML. */
export function buildSavePayload(i: SavePayloadInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    title: i.title.trim(),
    content_html: i.html,
    content: i.text.trim(),
    kind: i.kind,
    language: i.language,
    use_in_ai: i.useInAi,
    collection_id: i.collectionId,
    review_by: i.reviewBy || null,
    attachments: stagedAttachments(i.attachments, i.html),
  }
  if (i.status) body.status = i.status
  if (i.sourceConversationId) body.source_conversation_id = i.sourceConversationId
  return body
}

/** Accept either a bare array or an object wrapping it, so the editor does
 *  not break on a small difference in the list responses. */
export function unwrapList<T>(data: unknown, key: string): T[] {
  if (Array.isArray(data)) return data as T[]
  if (data && typeof data === 'object') {
    const inner = (data as Record<string, unknown>)[key]
    if (Array.isArray(inner)) return inner as T[]
  }
  return []
}

/** Turn what someone typed into a link the server's sanitiser will keep
 *  (http, https, mailto, tel). Bare domains and emails are completed; anything
 *  else, such as `javascript:`, returns null. */
export function normalizeLinkUrl(input: string): string | null {
  const v = input.trim()
  if (!v) return null
  if (/^(https?:\/\/|mailto:|tel:)\S+$/i.test(v)) return v
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return `mailto:${v}`
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return null
  if (/^[^\s/]+\.[^\s/]+(\/\S*)?$/.test(v)) return `https://${v}`
  return null
}
