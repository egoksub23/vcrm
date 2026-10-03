// ============================================================
// The Vircle Chat webhook payloads (docs/vircle-chat-contract.md, section 3),
// read defensively. The sender is our own gateway, but its bytes are still
// outside input: every field is checked, unknown fields and event types are
// ignored (so the contract can grow), and nothing the sender says about the
// workspace is believed beyond `workspace_key`.
// ============================================================

export const MESSAGE_TYPES = ['text', 'image', 'video', 'audio', 'document'] as const
export type VircleMessageType = (typeof MESSAGE_TYPES)[number]

export const TEXT_MAX = 4000
export const CAPTION_MAX = 1024

export interface VircleUser {
  walletId: string
  name: string | null
  phone: string | null
  email: string | null
}

export interface VircleMedia {
  url: string
  mimeType: string
  fileName: string | null
  sizeBytes: number | null
  /** The length of a voice note, in whole seconds (contract 1.2). Absent or invalid: null. */
  durationSeconds?: number | null
  /** A GIF sent as a looping MP4 (contract 1.3). Absent or anything but true: false. */
  animated?: boolean
}

export interface InboundEvent {
  kind: 'message.inbound'
  eventId: string
  workspaceKey: string
  user: VircleUser
  conversationId: string | null
  message: {
    serverId: string
    clientId: string | null
    seq: number | null
    type: VircleMessageType
    text: string | null
    sentAt: string | null
    media: VircleMedia | null
    /** The gateway id of the message this one replies to (contract 1.2), when the user quoted one. */
    replyToServerId?: string | null
  }
}

export interface ReceiptEvent {
  kind: 'message.receipt'
  eventId: string
  workspaceKey: string
  serverId: string
  status: 'delivered' | 'read' | 'failed'
  at: string | null
  error: { code: string; message: string } | null
}

/** The user is typing (contract 3.4, 1.2): ephemeral, never stored. */
export interface TypingEvent {
  kind: 'user.typing'
  eventId: string
  workspaceKey: string
  walletId: string
  conversationId: string | null
}

export type ParsedEvent =
  | { ok: true; event: InboundEvent | ReceiptEvent | TypingEvent }
  | { ok: true; ignored: string }
  | { ok: false; error: string }

const fail = (error: string): ParsedEvent => ({ ok: false, error })

function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t && t.length <= max ? t : null
}

/** An optional string: absent / null is fine, a present value must be valid. */
function optStr(v: unknown, max: number): { ok: true; value: string | null } | { ok: false } {
  if (v === undefined || v === null || v === '') return { ok: true, value: null }
  const s = str(v, max)
  return s === null ? { ok: false } : { ok: true, value: s }
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

function parseMedia(v: unknown): VircleMedia | null | 'invalid' {
  if (v === undefined || v === null) return null
  if (typeof v !== 'object') return 'invalid'
  const m = v as Record<string, unknown>
  const url = str(m.url, 2048)
  const mimeType = str(m.mime_type, 100)
  if (!url || !mimeType) return 'invalid'
  try {
    if (new URL(url).protocol !== 'https:') return 'invalid'
  } catch {
    return 'invalid'
  }
  const name = optStr(m.file_name, 255)
  if (!name.ok) return 'invalid'
  const size = typeof m.size_bytes === 'number' && Number.isFinite(m.size_bytes) && m.size_bytes >= 0 ? m.size_bytes : null
  // A voice note's length: a whole number of seconds, 0 or more. Anything else is ignored, never an error.
  const duration = typeof m.duration_seconds === 'number' && Number.isInteger(m.duration_seconds) && m.duration_seconds >= 0 ? m.duration_seconds : null
  const mime = mimeType.toLowerCase()
  // Only an MP4 video can be a GIF; a flag on anything else is ignored, never an error.
  const animated = m.animated === true && mime === 'video/mp4'
  return { url, mimeType: mime, fileName: name.value, sizeBytes: size, durationSeconds: duration, ...(animated ? { animated: true } : {}) }
}

export function parseWebhookEvent(raw: unknown): ParsedEvent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('body must be a JSON object')
  const b = raw as Record<string, unknown>
  const event = typeof b.event === 'string' ? b.event : ''
  const eventId = str(b.event_id, 200)
  const workspaceKey = str(b.workspace_key, 200)
  if (!event) return fail('event is required')
  if (!eventId) return fail('event_id is required')
  if (!workspaceKey) return fail('workspace_key is required')

  if (event === 'message.receipt') {
    const serverId = str(b.server_id, 200)
    if (!serverId) return fail('server_id is required')
    if (b.status !== 'delivered' && b.status !== 'read' && b.status !== 'failed') {
      return fail('status must be delivered, read or failed')
    }
    let error: ReceiptEvent['error'] = null
    if (b.error && typeof b.error === 'object') {
      const e = b.error as Record<string, unknown>
      error = { code: str(e.code, 100) ?? 'unknown', message: str(e.message, 500) ?? '' }
    }
    return { ok: true, event: { kind: 'message.receipt', eventId, workspaceKey, serverId, status: b.status, at: isoOrNull(b.at), error } }
  }

  if (event === 'user.typing') {
    const tu = b.user && typeof b.user === 'object' ? (b.user as Record<string, unknown>) : null
    const typingWallet = tu ? str(tu.wallet_id, 200) : null
    if (!typingWallet) return fail('user.wallet_id is required')
    // The conversation id is only a hint: a bad one is ignored, not a reason to refuse a typing signal.
    const typingConversation = optStr(b.conversation_id, 200)
    return {
      ok: true,
      event: {
        kind: 'user.typing',
        eventId,
        workspaceKey,
        walletId: typingWallet,
        conversationId: typingConversation.ok ? typingConversation.value : null,
      },
    }
  }

  if (event !== 'message.inbound') return { ok: true, ignored: event.slice(0, 100) }

  const u = b.user && typeof b.user === 'object' ? (b.user as Record<string, unknown>) : null
  const walletId = u ? str(u.wallet_id, 200) : null
  if (!u || !walletId) return fail('user.wallet_id is required')
  const name = optStr(u.name, 200)
  const phone = optStr(u.phone, 40)
  const email = optStr(u.email, 320)
  if (!name.ok || !phone.ok || !email.ok) return fail('user.name, user.phone or user.email is invalid')
  if (email.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value)) return fail('user.email is invalid')

  const m = b.message && typeof b.message === 'object' ? (b.message as Record<string, unknown>) : null
  if (!m) return fail('message is required')
  const serverId = str(m.server_id, 200)
  if (!serverId) return fail('message.server_id is required')
  const type = (MESSAGE_TYPES as readonly string[]).includes(m.type as string) ? (m.type as VircleMessageType) : null
  if (!type) return fail('message.type must be text, image, video, audio or document')
  const media = parseMedia(m.media)
  if (media === 'invalid') return fail('message.media needs an https url and a mime_type')
  if (type !== 'text' && !media) return fail('message.media is required for a file message')
  const text = typeof m.text === 'string' && m.text.trim() ? m.text.trim() : null
  if (type === 'text' && !text) return fail('message.text is required for a text message')
  if (text && text.length > (type === 'text' ? TEXT_MAX : CAPTION_MAX)) return fail('message.text is too long')
  const conversationId = optStr(b.conversation_id, 200)
  if (!conversationId.ok) return fail('conversation_id is invalid')
  const clientId = optStr(m.client_id, 200)
  if (!clientId.ok) return fail('message.client_id is invalid')
  // A reply's target is a hint: an unreadable id means "not a reply", never a refused message.
  const replyTo = optStr(m.reply_to_server_id, 200)

  return {
    ok: true,
    event: {
      kind: 'message.inbound',
      eventId,
      workspaceKey,
      user: { walletId, name: name.value, phone: phone.value, email: email.value?.toLowerCase() ?? null },
      conversationId: conversationId.value,
      message: {
        serverId,
        clientId: clientId.value,
        seq: typeof m.seq === 'number' && Number.isInteger(m.seq) ? m.seq : null,
        type,
        text,
        sentAt: isoOrNull(m.sent_at),
        media: type === 'text' ? null : media,
        replyToServerId: replyTo.ok ? replyTo.value : null,
      },
    },
  }
}

// ------------------------------------------------------------
// Halo to gateway (section 4)
// ------------------------------------------------------------

export type Delivery = 'socket' | 'push' | 'queued' | 'no_device'

export interface GatewayAccepted {
  serverId: string
  seq: number | null
  conversationId: string | null
  delivery: Delivery
}

/** Read the gateway's `202` answer; unknown `delivery` values are kept as `queued` (a new value must not break sending). */
export function parseGatewayAccepted(raw: unknown): GatewayAccepted | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const serverId = str(r.server_id, 200)
  if (!serverId) return null
  const d = r.delivery
  const delivery: Delivery = d === 'socket' || d === 'push' || d === 'queued' || d === 'no_device' ? d : 'queued'
  return {
    serverId,
    seq: typeof r.seq === 'number' && Number.isInteger(r.seq) ? r.seq : null,
    conversationId: str(r.conversation_id, 200),
    delivery,
  }
}

export interface GatewayError {
  code: string
  message: string
}

export function parseGatewayError(raw: unknown): GatewayError {
  const e = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).error : null
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>
    return { code: str(o.code, 100) ?? 'unknown', message: str(o.message, 500) ?? 'The chat gateway refused the message' }
  }
  return { code: 'unknown', message: 'The chat gateway refused the message' }
}
