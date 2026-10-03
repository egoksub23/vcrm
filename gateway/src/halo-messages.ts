// ============================================================
// A message from Halo to a user, once it has been checked: find or create the user, store the message
// (idempotent on Halo's key), and get it to them (src/delivery.ts). Shared by `POST /v1/messages` and by
// the simulator's "send as agent" box, so both take exactly the same path.
// ============================================================

import type { DeliveryService } from './delivery'
import type { Delivery, Identity, Store, Workspace } from './store'

export interface HaloMessageInput {
  idempotencyKey: string
  recipient: Identity
  text: string
  senderName: string | null
}

export interface HaloMessageAnswer {
  server_id: string
  seq: number
  conversation_id: string
  delivery: Delivery
}

export async function acceptHaloMessage(
  s: { store: Store; delivery: DeliveryService },
  workspace: Workspace,
  input: HaloMessageInput,
): Promise<HaloMessageAnswer> {
  const subject = await s.store.upsertUser(workspace, input.recipient)
  const { message, duplicate } = await s.store.appendOutbound(subject, {
    idempotencyKey: input.idempotencyKey,
    type: 'text',
    text: input.text,
    senderName: input.senderName,
  })
  // A repeat is answered as the first time was; only a new message is delivered.
  const delivery = duplicate ? (message.delivery ?? 'queued') : await s.delivery.deliverFromHalo(subject, message)
  return { server_id: message.id, seq: message.seq, conversation_id: message.conversation_id, delivery }
}
