// ============================================================
// Web Widget v2 — attachment rules shared by /api/widget/upload-url
// and /api/widget/message.
//
// The allow-list mirrors the `chat-media` bucket exactly (migration 023;
// the bucket settings are NOT changed by the widget work), and the size
// cap is the bucket's 16 MB. The widget uploads straight to Storage with
// a signed upload token, so these checks run twice: once when the token
// is issued (cheap, declared values) and again when the message arrives
// (the object's REAL size and content type from Storage).
// ============================================================

export const WIDGET_MEDIA_BUCKET = 'chat-media'

/** 16 MB, the bucket's file_size_limit. */
export const WIDGET_MAX_FILE_BYTES = 16 * 1024 * 1024
/** Voice notes are capped at five minutes. */
export const WIDGET_MAX_VOICE_SECONDS = 5 * 60

export type WidgetMediaKind = 'image' | 'video' | 'audio' | 'document'
export const WIDGET_MEDIA_KINDS: readonly WidgetMediaKind[] = ['image', 'video', 'audio', 'document']

/** Same list as the chat-media bucket's allowed_mime_types (migration 023). */
export const WIDGET_ALLOWED_MIME_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'video/mp4',
  'video/3gpp',
  'application/pdf',
  'application/vnd.ms-powerpoint',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'audio/ogg',
  'audio/mpeg',
  'audio/aac',
  'audio/mp4',
  'audio/amr',
]

export function widgetLimits() {
  return {
    maxFileBytes: WIDGET_MAX_FILE_BYTES,
    maxVoiceSeconds: WIDGET_MAX_VOICE_SECONDS,
    allowedMimeTypes: [...WIDGET_ALLOWED_MIME_TYPES],
  }
}

/** Strip parameters and case: `Audio/Ogg; codecs=opus` -> `audio/ogg`. */
export function baseMime(mime: unknown): string {
  return typeof mime === 'string' ? mime.split(';')[0].trim().toLowerCase() : ''
}

export function isAllowedMime(mime: unknown): boolean {
  return WIDGET_ALLOWED_MIME_TYPES.includes(baseMime(mime))
}

/** The message `content_type` a MIME type belongs to. */
export function kindForMime(mime: unknown): WidgetMediaKind {
  const m = baseMime(mime)
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  return 'document'
}

export function isMediaKind(kind: unknown): kind is WidgetMediaKind {
  return typeof kind === 'string' && (WIDGET_MEDIA_KINDS as readonly string[]).includes(kind)
}

/** Every widget upload for a conversation lives under this prefix. */
export function widgetMediaPrefix(accountId: string, conversationId: string): string {
  return `account-${accountId}/widget/${conversationId}/`
}

/** Safe object-name tail: no separators, no exotic characters, bounded. */
export function sanitizeUploadFileName(raw: string): string {
  const base = (raw.split(/[\\/]/).pop() ?? '').trim()
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot + 1).replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 8) : ''
  const stem = (dot > 0 ? base.slice(0, dot) : base).replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
  const safeStem = stem || 'file'
  return ext ? `${safeStem}.${ext}` : safeStem
}

export function buildWidgetMediaPath(
  accountId: string,
  conversationId: string,
  uuid: string,
  fileName: string,
): string {
  return `${widgetMediaPrefix(accountId, conversationId)}${uuid}-${sanitizeUploadFileName(fileName)}`
}

export interface DeclaredMedia {
  path: string
  mimeType: string
  fileName: string
  sizeBytes: number
  kind: WidgetMediaKind
  durationSeconds?: number
}

export type MediaErrorCode = 'bad_request' | 'file_too_large' | 'file_type_not_allowed'

export type MediaParseResult =
  | { ok: true; media: DeclaredMedia }
  | { ok: false; status: number; code: MediaErrorCode; error: string }

/**
 * Validate the declared shape of a `media` object (no I/O). Checks type
 * shapes, the path prefix (the visitor may only reference objects under
 * their own conversation), mime, size, kind and voice duration.
 */
export function parseDeclaredMedia(
  raw: unknown,
  accountId: string,
  conversationId: string,
): MediaParseResult {
  const fail = (status: number, code: MediaErrorCode, error: string): MediaParseResult => ({ ok: false, status, code, error })
  if (!raw || typeof raw !== 'object') return fail(400, 'bad_request', 'media must be an object')
  const m = raw as Record<string, unknown>

  const path = typeof m.path === 'string' ? m.path : ''
  const mimeType = baseMime(m.mimeType)
  const fileName = typeof m.fileName === 'string' ? m.fileName.trim().slice(0, 200) : ''
  const sizeBytes = typeof m.sizeBytes === 'number' ? m.sizeBytes : NaN
  const kind = m.kind

  if (!path || path.includes('..') || !path.startsWith(widgetMediaPrefix(accountId, conversationId))) {
    return fail(400, 'bad_request', 'media.path is not valid for this conversation')
  }
  if (!isMediaKind(kind)) return fail(400, 'bad_request', 'media.kind is not valid')
  if (!fileName) return fail(400, 'bad_request', 'media.fileName is required')
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return fail(400, 'bad_request', 'media.sizeBytes is not valid')
  if (sizeBytes > WIDGET_MAX_FILE_BYTES) return fail(413, 'file_too_large', 'File is larger than 16 MB')
  if (!isAllowedMime(mimeType)) return fail(415, 'file_type_not_allowed', 'This file type is not allowed')
  if (kindForMime(mimeType) !== kind) return fail(400, 'bad_request', 'media.kind does not match the file type')

  let durationSeconds: number | undefined
  if (m.durationSeconds !== undefined && m.durationSeconds !== null) {
    if (typeof m.durationSeconds !== 'number' || !Number.isFinite(m.durationSeconds) || m.durationSeconds < 0) {
      return fail(400, 'bad_request', 'media.durationSeconds is not valid')
    }
    if (kind === 'audio' && m.durationSeconds > WIDGET_MAX_VOICE_SECONDS) {
      return fail(413, 'file_too_large', 'Voice notes are limited to 5 minutes')
    }
    durationSeconds = Math.round(m.durationSeconds)
  }

  return { ok: true, media: { path, mimeType, fileName, sizeBytes, kind, durationSeconds } }
}

export interface StoredObjectInfo {
  size?: number | null
  contentType?: string | null
}

/**
 * Compare the object Storage really holds with what the visitor declared.
 * Size may differ by nothing (it is the exact byte count); the content type
 * is compared on its base type. A mismatch means the visitor lied about the
 * file, so the caller deletes the object.
 */
export function checkStoredObject(
  declared: DeclaredMedia,
  stored: StoredObjectInfo,
): { ok: true } | { ok: false; status: number; code: MediaErrorCode; error: string } {
  const size = typeof stored.size === 'number' ? stored.size : NaN
  if (!Number.isFinite(size)) {
    return { ok: false, status: 400, code: 'bad_request', error: 'Could not read the uploaded file' }
  }
  if (size > WIDGET_MAX_FILE_BYTES) {
    return { ok: false, status: 413, code: 'file_too_large', error: 'File is larger than 16 MB' }
  }
  const storedMime = baseMime(stored.contentType)
  if (!isAllowedMime(storedMime)) {
    return { ok: false, status: 415, code: 'file_type_not_allowed', error: 'This file type is not allowed' }
  }
  if (size !== declared.sizeBytes || storedMime !== declared.mimeType) {
    // A different size or type than declared: treat as a type problem when
    // the type changed, otherwise a size problem.
    if (storedMime !== declared.mimeType) {
      return { ok: false, status: 415, code: 'file_type_not_allowed', error: 'The uploaded file does not match what was declared' }
    }
    return { ok: false, status: 413, code: 'file_too_large', error: 'The uploaded file does not match what was declared' }
  }
  return { ok: true }
}
