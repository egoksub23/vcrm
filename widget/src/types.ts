// Shared types for the widget bundle. Kept free of runtime imports so
// the pure helper modules (and their tests) stay dependency-light.

export type Locale = 'en' | 'ms' | 'zh'

export type MediaKind = 'image' | 'video' | 'audio' | 'document'

export interface Branding {
  name: string
  welcomeMessage: string
  primaryColor: string
  avatarUrl: string | null
  position: 'left' | 'right'
}

export type IdentityLevel = 'guest' | 'claimed' | 'verified'

export interface IdentityInfo {
  level: IdentityLevel
  hasPhone: boolean
  hasEmail: boolean
  displayName: string | null
}

export interface WidgetLimits {
  maxFileBytes: number
  maxVoiceSeconds: number
  allowedMimeTypes: string[]
}

/** Used until (or unless) the server sends `limits` — mirrors the
 *  chat-media bucket allow-list, which is what the server enforces. */
export const DEFAULT_LIMITS: WidgetLimits = {
  maxFileBytes: 16 * 1024 * 1024,
  maxVoiceSeconds: 5 * 60,
  allowedMimeTypes: [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'video/mp4',
    'video/3gpp',
    'video/quicktime',
    'application/pdf',
    'application/vnd.ms-powerpoint',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'audio/ogg',
    'audio/mpeg',
    'audio/aac',
    'audio/mp4',
    'audio/amr',
  ],
}

export type SenderType = 'customer' | 'agent' | 'bot'
export type ContentType = 'text' | 'image' | 'video' | 'audio' | 'document' | string

/** A `messages` row as the widget reads it (RLS-scoped SELECT / Realtime). */
export interface WidgetMessage {
  id: string
  sender_type: SenderType
  content_text: string | null
  content_type?: ContentType | null
  media_url?: string | null
  status?: string | null
  created_at: string
  is_internal?: boolean | null
}

/** A message plus the client-only state used while it is in flight. */
export interface LocalMessage extends WidgetMessage {
  /** Optimistic — the server has not confirmed it yet. */
  pending?: boolean
  /** Send/upload failed; the visitor can tap to retry. */
  failed?: boolean
  /** blob: URL of the file being uploaded (revoked once confirmed). */
  localUrl?: string | null
  localFileName?: string | null
  localSizeBytes?: number | null
  localDurationSeconds?: number | null
  /** What to send again on retry. */
  retry?: { text?: string; file?: File; kind?: MediaKind; durationSeconds?: number }
}

/** What the host page can hand the widget (data-* attributes / VircleWidget.identify). */
export interface IdentityInput {
  /** Signed by the host app's backend — the only input that counts as verified. */
  token?: string
  /** LEGACY: sent to the server as an UNVERIFIED claim. */
  phone?: string
  email?: string
  name?: string
  /** LEGACY: no longer sent (the contract has no wallet-id claim). */
  walletId?: string
}
