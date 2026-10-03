// Frames the gateway sends to the app (see protocol.ts for the full list).

import type { GatewayConfig } from './config'
import type { FileService } from './files'
import { PROTOCOL_VERSION } from './protocol'
import type { Message, Subject } from './store'

const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString()

export function welcomeFrame(subject: Subject, cfg: GatewayConfig): Record<string, unknown> {
  return {
    type: 'welcome',
    v: PROTOCOL_VERSION,
    server_time: new Date().toISOString(),
    heartbeat_s: cfg.heartbeatSeconds,
    limits: {
      text_max: cfg.limits.textMax,
      caption_max: cfg.limits.captionMax,
      file_max_bytes: cfg.limits.fileMaxBytes,
      send_per_window: cfg.sendRateLimit.limit,
      send_window_s: Math.round(cfg.sendRateLimit.windowMs / 1000),
    },
    user: { wallet_id: subject.user.wallet_id, name: subject.user.name },
    conversation: { id: subject.conversation.id, last_seq: subject.conversation.last_seq },
  }
}

/**
 * A message as the app sees it. `direction` is `out` for Halo's messages, `in` for the user's own. A file's
 * `media` carries a link to the gateway's copy (made now); `reply_to` is the quoted message, if any.
 */
export function deliverFrame(message: Message, files: FileService | null): Record<string, unknown> {
  return {
    type: 'deliver',
    server_id: message.id,
    seq: message.seq,
    conversation_id: message.conversation_id,
    direction: message.direction,
    kind: message.type,
    text: message.text,
    media: files ? files.mediaForApp(message.media) : message.media,
    reply_to: message.reply_to ?? null,
    sender: { name: message.sender_name },
    sent_at: iso(message.created_at),
    status: message.status,
  }
}

export function ackFrame(clientId: string, message: Message, duplicate: boolean): Record<string, unknown> {
  return {
    type: 'ack',
    client_id: clientId,
    server_id: message.id,
    seq: message.seq,
    conversation_id: message.conversation_id,
    ...(duplicate ? { duplicate: true } : {}),
  }
}

/** `extra` names what the error is about: `client_id` for a send, `request_id` for an upload request. */
export function errorFrame(code: string, message: string, retryAfterSeconds?: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'error', code, message, ...(retryAfterSeconds ? { retry_after: retryAfterSeconds } : {}), ...extra }
}

/** Support's side of the user's own messages: Halo received them (`delivered`) or an agent read them (`read`). */
export function receiptFrame(conversationId: string, status: 'delivered' | 'read', messages: Pick<Message, 'id' | 'seq'>[]): Record<string, unknown> {
  return { type: 'receipt', conversation_id: conversationId, status, messages: messages.map((m) => ({ server_id: m.id, seq: m.seq })) }
}

/** An agent is typing. The app shows it for a few seconds after the last one. */
export function typingFrame(conversationId: string): Record<string, unknown> {
  return { type: 'typing', conversation_id: conversationId, from: 'support' }
}

export function uploadSlotFrame(requestId: string, slot: { fileId: string; uploadUrl: string; expiresAt: Date; maxBytes: number }): Record<string, unknown> {
  return { type: 'upload_slot', request_id: requestId, file_id: slot.fileId, upload_url: slot.uploadUrl, expires_at: slot.expiresAt.toISOString(), max_bytes: slot.maxBytes }
}

export function fileUrlFrame(fileId: string, link: { url: string; expiresAt: Date }): Record<string, unknown> {
  return { type: 'file_url', file_id: fileId, url: link.url, expires_at: link.expiresAt.toISOString() }
}
