// Frames the gateway sends to the app (see protocol.ts for the full list).

import type { GatewayConfig } from './config'
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

/** A message as the app sees it. `direction` is `out` for Halo's messages, `in` for the user's own. */
export function deliverFrame(message: Message): Record<string, unknown> {
  return {
    type: 'deliver',
    server_id: message.id,
    seq: message.seq,
    conversation_id: message.conversation_id,
    direction: message.direction,
    kind: message.type,
    text: message.text,
    media: message.media,
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

export function errorFrame(code: string, message: string, retryAfterSeconds?: number): Record<string, unknown> {
  return { type: 'error', code, message, ...(retryAfterSeconds ? { retry_after: retryAfterSeconds } : {}) }
}
