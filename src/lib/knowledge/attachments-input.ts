import {
  KB_ATTACHMENT_MAX_BYTES,
  KB_CAPTION_MAX_CHARS,
  KB_MAX_ATTACHMENTS,
  attachmentKindFor,
  type KbAttachmentKind,
  type StagedKnowledgeAttachment,
} from '@/lib/knowledge-types'

// ============================================================
// Validation and diffing for an article's attachment list (the `attachments`
// field of POST / PATCH /api/knowledge). Pure, so the rules are testable and
// the routes stay thin.
// ============================================================

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_NAME_CHARS = 200
const MAX_MIME_CHARS = 100

export type ParsedAttachments =
  | { ok: true; items: StagedKnowledgeAttachment[] }
  | { ok: false; error: string }

/** A file name safe to store and to show: no path parts, no control chars. */
export function cleanFileName(raw: string): string {
  return raw
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\\/]+/g, '_')
    .trim()
    .slice(0, MAX_NAME_CHARS)
}

/** The object path must sit in the caller's own account folder and cannot
 *  climb out of it. */
export function isOwnStoragePath(path: string, accountId: string): boolean {
  const prefix = `account-${accountId}/`
  if (!path.startsWith(prefix) || path.length <= prefix.length) return false
  const rest = path.slice(prefix.length)
  if (rest.includes('..') || rest.includes('//') || rest.includes('\\') || rest.startsWith('/')) return false
  return !/[\x00-\x1f\x7f]/.test(rest)
}

export function maxBytesFor(kind: KbAttachmentKind): number {
  return kind === 'image' ? KB_ATTACHMENT_MAX_BYTES.image : KB_ATTACHMENT_MAX_BYTES.other
}

/** A caption as stored: one line of plain text, or null when blank. */
export function cleanCaption(raw: string): string | null {
  const c = raw
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, KB_CAPTION_MAX_CHARS)
  return c || null
}

/**
 * Parse the `attachments` array from a request body. An entry with an `id`
 * is an existing attachment being kept (only its `send_with_ai` may change);
 * an entry without one is a new upload and is validated in full: its object
 * path must be under `account-<accountId>/`, its size within the cap for its
 * kind, and the list within `KB_MAX_ATTACHMENTS`. Both may carry `inline`
 * (an image shown inside the article) and a `caption`.
 */
export function parseStagedAttachments(value: unknown, accountId: string): ParsedAttachments {
  if (!Array.isArray(value)) return { ok: false, error: 'attachments must be a list' }
  if (value.length > KB_MAX_ATTACHMENTS) {
    return { ok: false, error: `An article can have at most ${KB_MAX_ATTACHMENTS} attachments.` }
  }

  const items: StagedKnowledgeAttachment[] = []
  const seenIds = new Set<string>()
  const seenPaths = new Set<string>()

  for (const raw of value) {
    const e = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null
    if (!e) return { ok: false, error: 'Each attachment must be an object.' }

    const sendWithAi = e.send_with_ai === undefined ? true : e.send_with_ai
    if (typeof sendWithAi !== 'boolean') return { ok: false, error: 'send_with_ai must be true or false' }

    const inline = e.inline === undefined || e.inline === null ? false : e.inline
    if (typeof inline !== 'boolean') return { ok: false, error: 'inline must be true or false' }
    let caption: string | null = null
    if (e.caption !== undefined && e.caption !== null) {
      if (typeof e.caption !== 'string') return { ok: false, error: 'caption must be text' }
      if (e.caption.length > KB_CAPTION_MAX_CHARS * 2) {
        return { ok: false, error: `A caption is limited to ${KB_CAPTION_MAX_CHARS} characters.` }
      }
      caption = cleanCaption(e.caption)
    }

    if (e.id !== undefined && e.id !== null) {
      if (typeof e.id !== 'string' || !UUID.test(e.id)) return { ok: false, error: 'Attachment id is not valid.' }
      if (seenIds.has(e.id)) return { ok: false, error: 'An attachment is listed twice.' }
      seenIds.add(e.id)
      items.push({
        id: e.id,
        file_name: typeof e.file_name === 'string' ? e.file_name : '',
        mime_type: typeof e.mime_type === 'string' ? e.mime_type : '',
        size_bytes: typeof e.size_bytes === 'number' ? e.size_bytes : 0,
        url: typeof e.url === 'string' ? e.url : '',
        storage_path: typeof e.storage_path === 'string' ? e.storage_path : '',
        send_with_ai: sendWithAi,
        // Left out = leave the stored value alone.
        ...(e.inline === undefined ? {} : { inline }),
        ...(e.caption === undefined ? {} : { caption }),
      })
      continue
    }

    const fileName = typeof e.file_name === 'string' ? cleanFileName(e.file_name) : ''
    if (!fileName) return { ok: false, error: 'Each attachment needs a file name.' }

    const mime =
      typeof e.mime_type === 'string' && e.mime_type.trim()
        ? e.mime_type.trim().toLowerCase().slice(0, MAX_MIME_CHARS)
        : 'application/octet-stream'

    const size = e.size_bytes
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
      return { ok: false, error: `"${fileName}" has no valid size.` }
    }
    const kind = attachmentKindFor(mime)
    if (size > maxBytesFor(kind)) {
      const mb = Math.round(maxBytesFor(kind) / (1024 * 1024))
      return { ok: false, error: `"${fileName}" is too large (${kind === 'image' ? 'images' : 'files'} are limited to ${mb} MB).` }
    }

    const path = e.storage_path
    if (typeof path !== 'string' || !isOwnStoragePath(path, accountId)) {
      return { ok: false, error: `"${fileName}" was not uploaded to your account's storage.` }
    }
    if (seenPaths.has(path)) return { ok: false, error: `"${fileName}" is listed twice.` }
    seenPaths.add(path)

    const url = e.url
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return { ok: false, error: `"${fileName}" has no valid link.` }
    }

    items.push({
      file_name: fileName,
      mime_type: mime,
      size_bytes: Math.round(size),
      url,
      storage_path: path,
      send_with_ai: sendWithAi,
      inline,
      caption,
    })
  }
  return { ok: true, items }
}

export interface AttachmentPlan {
  /** Existing rows to keep, with their new order and switch. */
  keep: {
    id: string
    position: number
    send_with_ai: boolean
    /** undefined = not sent, leave the stored value. */
    inline?: boolean
    caption?: string | null
  }[]
  /** New rows to insert, with their order. */
  add: (StagedKnowledgeAttachment & { position: number })[]
  /** Existing rows that are no longer listed. */
  removeIds: string[]
  /** Ids in the list that are not attachments of this article. */
  unknownIds: string[]
}

/** Work out what a save changes: kept rows (id present), new rows (no id),
 *  and removed rows (existing but missing from the list). Order in the list
 *  becomes `position`. */
export function planAttachmentChanges(
  existingIds: string[],
  staged: StagedKnowledgeAttachment[],
): AttachmentPlan {
  const existing = new Set(existingIds)
  const plan: AttachmentPlan = { keep: [], add: [], removeIds: [], unknownIds: [] }
  const listed = new Set<string>()
  staged.forEach((item, position) => {
    if (item.id) {
      if (!existing.has(item.id)) {
        plan.unknownIds.push(item.id)
        return
      }
      listed.add(item.id)
      plan.keep.push({
        id: item.id,
        position,
        send_with_ai: item.send_with_ai,
        ...(item.inline === undefined ? {} : { inline: item.inline }),
        ...(item.caption === undefined ? {} : { caption: item.caption }),
      })
    } else {
      plan.add.push({ ...item, position })
    }
  })
  plan.removeIds = existingIds.filter((id) => !listed.has(id))
  return plan
}
