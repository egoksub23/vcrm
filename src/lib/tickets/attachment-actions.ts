import { createClient } from '@/lib/supabase/client'
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
  userId: string,
): Promise<TicketAttachment> {
  const ready = isImageMime(file.type)
    ? await prepareImageForUpload(file, { maxBytes: TICKET_IMAGE_MAX_BYTES })
    : file
  const { publicUrl, path } = await uploadAccountMedia(BUCKET, ready, SUBFOLDER)
  const { data, error } = await createClient()
    .from('ticket_attachments')
    .insert({
      ticket_id: ticket.id,
      account_id: ticket.account_id,
      storage_path: path,
      url: publicUrl,
      filename: ready.name || 'file',
      mime_type: ready.type || 'application/octet-stream',
      size_bytes: ready.size,
      uploaded_by: userId,
    })
    .select('*')
    .single()
  if (error || !data) {
    // Nothing points at the object now; do not leave it in the public bucket.
    void deleteAccountMedia(BUCKET, path).catch(() => {})
    throw new Error(error?.message ?? 'Could not save the attachment.')
  }
  return data as TicketAttachment
}

/** Remove the row, then the stored file (best effort: a missed delete is a storage nit). */
export async function removeTicketAttachment(att: TicketAttachment): Promise<boolean> {
  const { error } = await createClient().from('ticket_attachments').delete().eq('id', att.id)
  if (error) return false
  void deleteAccountMedia(BUCKET, att.storage_path).catch(() => {})
  return true
}
