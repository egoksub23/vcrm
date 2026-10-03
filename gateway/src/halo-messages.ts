// ============================================================
// A message from Halo to a user, once it has been checked: find or create the user, fetch the file if there
// is one, store the message (idempotent on Halo's key), and get it to them (src/delivery.ts). Shared by
// `POST /v1/messages` and by the simulator's "send as agent" box, so both take exactly the same path.
// ============================================================

import type { DeliveryService } from './delivery'
import type { FileKind, FileService } from './files'
import type { Delivery, Identity, MessageType, Store, Workspace } from './store'

export interface HaloMessageInput {
  idempotencyKey: string
  recipient: Identity
  /** The text, or the caption of a file. */
  text: string | null
  senderName: string | null
  /** The gateway id of the message this one quotes. */
  replyToServerId?: string | null
  /** A file: Halo's address for it (the gateway fetches it) or, from the simulator, bytes already in hand. */
  media?:
    | { kind: FileKind; url: string; mimeType: string; fileName: string | null; sizeBytes: number | null; durationSeconds: number | null }
    | { kind: FileKind; bytes: Buffer; mimeType: string; fileName: string | null; durationSeconds: number | null }
    | null
}

export interface HaloMessageAnswer {
  server_id: string
  seq: number
  conversation_id: string
  delivery: Delivery
}

export async function acceptHaloMessage(
  s: { store: Store; delivery: DeliveryService; files: FileService },
  workspace: Workspace,
  input: HaloMessageInput,
): Promise<HaloMessageAnswer> {
  // A repeat of a message already handled is answered as the first time was, without fetching its file again.
  const prior = await s.store.findOutboundByKey(workspace.id, input.idempotencyKey)
  if (prior) return { server_id: prior.id, seq: prior.seq, conversation_id: prior.conversation_id, delivery: prior.delivery ?? 'queued' }

  // A file that cannot be fetched or fails a check throws before anything is stored, the user included:
  // Halo hears `invalid_media` and nothing has changed.
  const incoming = input.media ? ('url' in input.media ? await s.files.fetchFromHalo(input.media.kind, input.media) : input.media) : null
  const subject = await s.store.upsertUser(workspace, input.recipient)
  let type: MessageType = 'text'
  let media = null
  if (incoming) {
    const row = await s.files.storeBytes(subject, 'halo', incoming)
    type = row.kind
    media = s.files.mediaOf(row)
  }
  const quote = input.replyToServerId ? await s.store.quoteFor(subject, input.replyToServerId) : null
  const { message, duplicate } = await s.store.appendOutbound(subject, {
    idempotencyKey: input.idempotencyKey,
    type,
    text: input.text,
    media,
    replyTo: quote,
    senderName: input.senderName,
  })
  // Only a new message is delivered.
  const delivery = duplicate ? (message.delivery ?? 'queued') : await s.delivery.deliverFromHalo(subject, message)
  return { server_id: message.id, seq: message.seq, conversation_id: message.conversation_id, delivery }
}
