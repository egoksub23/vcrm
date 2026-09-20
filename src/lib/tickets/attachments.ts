import type { TicketAttachment } from '@/types'

// Files on a ticket. They go to the same public `chat-media` bucket the
// knowledge base uses, under account-<id>/tickets/, so the bucket's own
// limits (16 MB, its MIME allow-list) apply and are surfaced from the upload
// error. The checks here only catch the common cases before uploading.

export const TICKET_MAX_ATTACHMENTS = 20

/** A picture is shrunk before upload, so this is the size after that. */
export const TICKET_IMAGE_MAX_BYTES = 5 * 1024 * 1024
/** Anything else, up to the bucket's own limit. */
export const TICKET_FILE_MAX_BYTES = 16 * 1024 * 1024

export type FileRejection =
  | { reason: 'tooMany'; max: number }
  | { reason: 'tooLarge'; maxBytes: number }

export function isImageMime(mime: string | null | undefined): boolean {
  return (mime ?? '').toLowerCase().startsWith('image/')
}

/** Why a file cannot be added, or null. Pictures are not size-checked here:
 *  they are shrunk first and refused then if they still do not fit. */
export function checkTicketFile(
  file: { size: number; type: string },
  existingCount: number,
): FileRejection | null {
  if (existingCount >= TICKET_MAX_ATTACHMENTS) return { reason: 'tooMany', max: TICKET_MAX_ATTACHMENTS }
  if (!isImageMime(file.type) && file.size > TICKET_FILE_MAX_BYTES) {
    return { reason: 'tooLarge', maxBytes: TICKET_FILE_MAX_BYTES }
  }
  return null
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

/** Images first (the thumbnail grid), then other files; each in upload order. */
export function splitAttachments(list: TicketAttachment[]): {
  images: TicketAttachment[]
  files: TicketAttachment[]
} {
  const byTime = [...list].sort((a, b) => a.created_at.localeCompare(b.created_at))
  return {
    images: byTime.filter((a) => isImageMime(a.mime_type)),
    files: byTime.filter((a) => !isImageMime(a.mime_type)),
  }
}
