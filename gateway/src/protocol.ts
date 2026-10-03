// ============================================================
// The WebSocket protocol between the Vircle app and the gateway
// (docs/vircle-chat-design.docx, section 5; docs/vircle-chat-gateway-scope.md).
//
// Every frame is one JSON object with a `type`. The first frame from the app must
// be `hello`. Version 1.
//
//   app -> gateway   hello    { v, token, device_id, app_version?, last_seq? }
//                    send     { client_id, kind, text?, media?: { file_id }, reply_to? }
//                    upload_request { request_id, kind, file_name?, mime_type, size_bytes, duration_seconds?, animated? }
//                    file_url { file_id }
//                    receipt  { up_to_seq, status: 'delivered' | 'read' }
//                    resume   { last_seq }
//                    typing   { }
//                    ping     { t? }
//   gateway -> app   welcome  { v, server_time, heartbeat_s, limits, user, conversation }
//                    ack      { client_id, server_id, seq, conversation_id, duplicate? }
//                    deliver  { server_id, seq, conversation_id, direction, kind, text, media, reply_to,
//                               sender, sent_at, status }
//                    upload_slot { request_id, file_id, upload_url, expires_at, max_bytes }
//                    file_url { file_id, url, expires_at }
//                    receipt  { conversation_id, status: 'delivered' | 'read', messages: [{ server_id, seq }] }
//                    typing   { conversation_id, from: 'support' }
//                    resume_done { conversation_id, up_to_seq, more }
//                    pong     { t? }
//                    error    { code, message, retry_after?, request_id?, client_id? }
//
// FILES. Bytes never travel on the socket. The app sends `upload_request`, gets an `upload_slot`, PUTs the bytes to
// `upload_url` over HTTPS (Content-Type = the declared mime_type, exactly `size_bytes` bytes), then sends a message
// whose `media.file_id` is that file. A `deliver` for a file carries `media: { file_id, url, expires_at, mime_type,
// file_name, size_bytes, duration_seconds, animated? }`; when `url` has expired the app asks `file_url` for a new one.
//
// RECEIPTS. The client's `receipt` is about Halo's messages (delivered / read). The gateway's `receipt` is about the
// user's own messages: `delivered` once Halo has them, `read` once an agent has read them.
//
// `direction` on a `deliver` is `out` for a message from Halo and `in` for one the user sent from
// another of their devices (or that a resume replays).
// ============================================================

import type { Limits } from './config'
import type { MessageType } from './store'

export const PROTOCOL_VERSION = 1

export type ClientFrame =
  | { type: 'hello'; v: number; token: string; deviceId: string; appVersion: string | null; lastSeq: number | null }
  | { type: 'send'; clientId: string; messageType: MessageType; text: string | null; media: { fileId: string } | null; replyTo: string | null }
  | { type: 'upload_request'; requestId: string; kind: unknown; fileName: unknown; mimeType: unknown; sizeBytes: unknown; durationSeconds: unknown; animated: unknown }
  | { type: 'file_url'; fileId: string }
  | { type: 'receipt'; upToSeq: number; status: 'delivered' | 'read' }
  | { type: 'resume'; lastSeq: number }
  | { type: 'typing' }
  | { type: 'ping'; t: unknown }

export type ParseResult = { ok: true; frame: ClientFrame } | { ok: false; code: string; message: string }

const bad = (code: string, message: string): ParseResult => ({ ok: false, code, message })

const MESSAGE_TYPES: readonly string[] = ['text', 'image', 'video', 'audio', 'document']

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null
}

function seq(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 2_000_000_000 ? v : null
}

/** Read one text frame from the app. Never throws. */
export function parseClientFrame(raw: string, limits: Limits): ParseResult {
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return bad('bad_frame', 'The frame is not JSON')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('bad_frame', 'The frame must be a JSON object')
  const f = body as Record<string, unknown>

  switch (f.type) {
    case 'hello': {
      if (f.v !== PROTOCOL_VERSION) return bad('unsupported_version', `Protocol version ${PROTOCOL_VERSION} is the only one supported`)
      const token = str(f.token, 200)
      const deviceId = str(f.device_id, 100)
      if (!token) return bad('bad_frame', 'hello needs a token')
      if (!deviceId) return bad('bad_frame', 'hello needs a device_id')
      const lastSeq = f.last_seq === undefined || f.last_seq === null ? null : seq(f.last_seq)
      if (f.last_seq !== undefined && f.last_seq !== null && lastSeq === null) return bad('bad_frame', 'last_seq must be a whole number')
      return { ok: true, frame: { type: 'hello', v: 1, token, deviceId, appVersion: str(f.app_version, 50), lastSeq } }
    }
    case 'send': {
      const clientId = str(f.client_id, 100)
      if (!clientId) return bad('bad_frame', 'send needs a client_id')
      // On the wire the kind of message is `kind`; `type` is the frame type.
      const kind = typeof f.kind === 'string' ? f.kind : null
      if (!kind || !MESSAGE_TYPES.includes(kind)) return bad('bad_frame', 'send needs a kind: text, image, video, audio or document')
      const text = typeof f.text === 'string' && f.text.trim() ? f.text.trim() : null
      const rawMedia = f.media && typeof f.media === 'object' && !Array.isArray(f.media) ? (f.media as Record<string, unknown>) : null
      const fileId = rawMedia ? str(rawMedia.file_id, 100) : null
      const replyTo = f.reply_to === undefined || f.reply_to === null ? null : str(f.reply_to, 100)
      if (f.reply_to !== undefined && f.reply_to !== null && !replyTo) return bad('bad_frame', 'reply_to must be the server_id of a message')
      if (kind === 'text') {
        if (!text) return bad('bad_frame', 'A text message needs text')
        if (text.length > limits.textMax) return bad('message_too_long', `A message may be at most ${limits.textMax} characters`)
      } else {
        if (!fileId) return bad('bad_frame', 'A file message needs media.file_id (upload the file first)')
        if (text && text.length > limits.captionMax) return bad('message_too_long', `A caption may be at most ${limits.captionMax} characters`)
      }
      return { ok: true, frame: { type: 'send', clientId, messageType: kind as MessageType, text, media: kind === 'text' || !fileId ? null : { fileId }, replyTo } }
    }
    case 'upload_request': {
      const requestId = str(f.request_id, 100)
      if (!requestId) return bad('bad_frame', 'upload_request needs a request_id')
      return { ok: true, frame: { type: 'upload_request', requestId, kind: f.kind, fileName: f.file_name, mimeType: f.mime_type, sizeBytes: f.size_bytes, durationSeconds: f.duration_seconds, animated: f.animated } }
    }
    case 'file_url': {
      const fileId = str(f.file_id, 100)
      if (!fileId) return bad('bad_frame', 'file_url needs a file_id')
      return { ok: true, frame: { type: 'file_url', fileId } }
    }
    case 'receipt': {
      const upToSeq = seq(f.up_to_seq)
      if (upToSeq === null) return bad('bad_frame', 'receipt needs up_to_seq')
      if (f.status !== 'delivered' && f.status !== 'read') return bad('bad_frame', 'receipt status must be delivered or read')
      return { ok: true, frame: { type: 'receipt', upToSeq, status: f.status } }
    }
    case 'resume': {
      const lastSeq = seq(f.last_seq)
      if (lastSeq === null) return bad('bad_frame', 'resume needs last_seq')
      return { ok: true, frame: { type: 'resume', lastSeq } }
    }
    case 'typing':
      return { ok: true, frame: { type: 'typing' } }
    case 'ping':
      return { ok: true, frame: { type: 'ping', t: f.t } }
    default:
      return bad('bad_frame', 'Unknown frame type')
  }
}
