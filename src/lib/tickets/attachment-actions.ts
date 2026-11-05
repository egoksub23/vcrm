import { prepareImageForUpload } from '@/lib/media/prepare-image'
import { deleteAccountMedia, uploadAccountMedia } from '@/lib/storage/upload-media'
import type { TicketAttachment } from '@/types'
import { TICKET_IMAGE_MAX_BYTES, isImageMime } from './attachments'

const BUCKET = 'chat-media'
const SUBFOLDER = 'tickets'

/**
 * Upload one file (a picture is shrunk first) and file it under the ticket.
 * Throws with a message the caller can show; an ImagePrepareError from the
 * picture step is left for the caller to translate.
 */
export async function attachFileToTicket(
  ticket: { id: string; account_id: string },
  file: File,
  _userId: string,
): Promise<TicketAttachment> {
  const ready = isImageMime(file.type)
    ? await prepareImageForUpload(file, { maxBytes: TICKET_IMAGE_MAX_BYTES })
    : file
  const { publicUrl, path } = await uploadAccountMedia(BUCKET, ready, SUBFOLDER)
  const res = await fetch(`/api/tickets/${encodeURIComponent(ticket.id)}/attachments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      storage_path: path,
      url: publicUrl,
      filename: ready.name || 'file',
      mime_type: ready.type || 'application/octet-stream',
      size_bytes: ready.size,
    }),
  }).catch(() => null)
  if (!res?.ok) {
    // Nothing points at the object now; do not leave it in the public bucket.
    void deleteAccountMedia(BUCKET, path).catch(() => {})
    throw new Error('Could not save the attachment.')
  }
  const json = (await res.json().catch(() => null)) as { attachment?: TicketAttachment } | null
  if (!json?.attachment) {
    void deleteAccountMedia(BUCKET, path).catch(() => {})
    throw new Error('Could not save the attachment.')
  }
  return json.attachment
}

/** Remove the row, then the stored file (best effort: a missed delete is a storage nit). */
export async function removeTicketAttachment(att: TicketAttachment): Promise<boolean> {
  const res = await fetch(
    `/api/tickets/${encodeURIComponent(att.ticket_id)}/attachments/${encodeURIComponent(att.id)}`,
    { method: 'DELETE' },
  ).catch(() => null)
  if (!res?.ok) return false
  void deleteAccountMedia(BUCKET, att.storage_path).catch(() => {})
  return true
}
