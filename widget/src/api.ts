// ============================================================
// Widget API calls:
//   POST /api/widget/anon-auth  anonymous visitor JWT (no Supabase)
//   POST /api/widget/session    identity + conversation bootstrap
//   POST /api/widget/enquiry    the "I have an enquiry" form
//   GET  /api/widget/messages   chat history (replaces PostgREST)
//   POST /api/widget/message    text and/or media
//   POST /api/widget/upload     file upload (replaces supabase.storage)
//   POST /api/widget/receipt    delivered / read reports for agent messages
//   POST /api/widget/media-url  signed links for the (private) chat media
// ============================================================
import { createMediaLinkResolver, resolveMessageMedia as resolveRowsMedia } from './media-links'
import { toWidgetMessages } from './util'
import type {
  Branding,
  IdentityInfo,
  Locale,
  MediaKind,
  WidgetLimits,
  WidgetMessage,
} from './types'

// `document.currentScript` is only reliable while THIS script is
// synchronously executing — which is exactly now, at module-evaluation
// time (the bundle is a plain classic script, not `type="module"`, so
// this still holds even with the `async` attribute on the tag). Reading
// it lazily inside a later callback would return null, so it's resolved
// once, eagerly, here — not as a function called on demand.
function resolveApiOrigin(): string {
  const script = document.currentScript as HTMLScriptElement | null
  if (script?.src) {
    try {
      return new URL(script.src).origin
    } catch {
      /* fall through */
    }
  }
  // Fallback for the rare case currentScript is unavailable: the last
  // <script data-widget-token> tag on the page.
  const tagged = document.querySelector('script[data-widget-token]') as HTMLScriptElement | null
  if (tagged?.src) {
    try {
      return new URL(tagged.src).origin
    } catch {
      /* fall through */
    }
  }
  return ''
}

/** Origin to call the widget API on — the origin this loader script
 *  itself was served from, however the CRM is self-hosted. Captured
 *  once at load time (see resolveApiOrigin). */
export const API_ORIGIN = resolveApiOrigin()

// ---------- errors ----------

export class ApiError extends Error {
  status: number
  code?: string
  retryAfterSeconds?: number
  constructor(message: string, status: number, code?: string, retryAfterSeconds?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** Longest any single widget request may hang before it counts as a network failure. */
export const REQUEST_TIMEOUT_MS = 20_000

/** Rejects (as a network ApiError) if `p` has not settled in time, so a stalled request can never leave "Loading…" up forever. */
export function withTimeout<T>(p: PromiseLike<T>, ms: number = REQUEST_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ApiError('Request timed out', 0, 'network')), ms)
    Promise.resolve(p).then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

// ---------- anonymous auth (localStorage-persisted JWT) ----------

const TOKEN_STORAGE_KEY = '__vw_token'

function readStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStoredToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token)
  } catch {
    /* ignore — session will work, just won't persist */
  }
}

function isTokenExpiringSoon(token: string): boolean {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return true
    const payload = JSON.parse(atob(parts[1])) as { exp?: unknown }
    if (typeof payload.exp !== 'number') return true
    // Refresh when < 1 hour remains
    return payload.exp < Math.floor(Date.now() / 1000) + 3600
  } catch {
    return true
  }
}

async function fetchNewToken(): Promise<string> {
  const res = await fetch(`${API_ORIGIN}/api/widget/anon-auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) {
    throw new ApiError('Failed to start an anonymous session', 401, 'auth')
  }
  const { token } = (await res.json()) as { token: string }
  if (!token) throw new ApiError('No token in anon-auth response', 401, 'auth')
  writeStoredToken(token)
  return token
}

async function currentAccessToken(): Promise<string> {
  const existing = readStoredToken()
  if (existing && !isTokenExpiringSoon(existing)) return existing
  return fetchNewToken()
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const token = await withTimeout(currentAccessToken())
  let res: Response
  try {
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = setTimeout(() => controller?.abort(), REQUEST_TIMEOUT_MS)
    try {
      res = await fetch(`${API_ORIGIN}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: controller?.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  } catch {
    throw new ApiError('Network error', 0, 'network')
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string }
  if (!res.ok) {
    const retryAfter = Number(res.headers.get('Retry-After'))
    throw new ApiError(
      data.error ?? `Request failed (${res.status})`,
      res.status,
      data.code ?? (res.status === 429 ? 'rate_limited' : undefined),
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    )
  }
  return data as T
}

// ---------- session / identity ----------

export interface Claim {
  phone?: string
  email?: string
  name?: string
  /** Reference-only on this unverified tier — never used to match/merge a
   *  contact, only stored on a brand-new one. See docs/web-chat-widget.md. */
  walletId?: string
}

export interface StartSessionOptions {
  visitorName?: string
  /** Signed by the host app's backend (data-identity-token / identify({token})). */
  identityToken?: string
  /** Typed by the visitor, or the legacy data-user-phone / identify({phone}) path. */
  claim?: Claim
  /** Visitor chose to stay a guest. */
  skipIdentity?: boolean
  locale?: Locale
}

export interface SessionResponse {
  needsIdentity?: boolean
  /** LEGACY alias of needsIdentity. */
  needsPhone?: boolean
  /** A code was just emailed for a matched claim (migration 110); the
   *  widget shows the code-entry screen instead of the chat. */
  needsVerification?: boolean
  conversationId?: string
  identity?: IdentityInfo
  isGuest?: boolean
  identityError?: 'bad_identity_token' | 'expired_identity_token'
  claimFound?: boolean
  branding: Branding
  verification?: { mode: 'none' | 'email_code' | 'whatsapp_code'; maskedEmail?: string }
  limits?: WidgetLimits
}

export function sessionNeedsIdentity(s: SessionResponse): boolean {
  return (s.needsIdentity ?? s.needsPhone ?? false) && !s.conversationId
}

export function startSession(widgetToken: string, opts: StartSessionOptions = {}): Promise<SessionResponse> {
  return post<SessionResponse>('/api/widget/session', {
    widgetToken,
    visitorName: opts.visitorName,
    identityToken: opts.identityToken,
    claim: opts.claim,
    skipIdentity: opts.skipIdentity,
    locale: opts.locale,
  })
}

/** Confirms a code sent for an email-code claim (migration 110). The
 *  visitor's bearer token alone identifies which pending code this is
 *  — no widgetToken needed. */
export function verifyCode(code: string): Promise<SessionResponse> {
  return post<SessionResponse>('/api/widget/verify-code', { code })
}

export type EnquiryRole = 'parent' | 'school' | 'merchant' | 'other'

export interface EnquiryInput {
  name: string
  phone?: string
  email?: string
  role: EnquiryRole
  message: string
  consent: true
  locale?: Locale
}

export function sendEnquiry(widgetToken: string, input: EnquiryInput): Promise<SessionResponse> {
  return post<SessionResponse>('/api/widget/enquiry', { widgetToken, ...input })
}

// ---------- messages ----------

export const HISTORY_PAGE_SIZE = 50

/**
 * Fetches one page of history via the server API (GET /api/widget/messages).
 * Newest page first (`before` = created_at cursor of the oldest row already shown
 * for older pages); returned oldest-first for display.
 */
export async function fetchMessages(
  conversationId: string,
  before?: string,
): Promise<{ rows: WidgetMessage[]; hasMore: boolean }> {
  const token = await withTimeout(currentAccessToken())
  const params = new URLSearchParams({ conversationId })
  if (before) params.set('before', before)

  let res: Response
  try {
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = setTimeout(() => controller?.abort(), REQUEST_TIMEOUT_MS)
    try {
      res = await fetch(`${API_ORIGIN}/api/widget/messages?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller?.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  } catch {
    throw new ApiError('Network error', 0, 'network')
  }

  const data = (await res.json().catch(() => ({}))) as {
    rows?: unknown[]
    hasMore?: boolean
    error?: string
    code?: string
  }
  if (!res.ok) {
    throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status, data.code)
  }

  // is_internal is filtered server-side; .reverse() for oldest-first display.
  const rows = await resolveMessageMedia(conversationId, toWidgetMessages(data.rows ?? []).reverse())
  return { rows, hasMore: data.hasMore ?? false }
}

// ---------- media links ----------

/**
 * chat-media is a private bucket: a stored `media_url` no longer serves the file,
 * so every file shown goes through a short-lived signed link from the server.
 * Links are cached by the stored url for a little under their lifetime, so
 * polling, re-renders and re-opens never ask twice.
 */
const mediaLinks = createMediaLinkResolver(async (conversationId, urls) => {
  const res = await post<{ urls?: Record<string, string> }>('/api/widget/media-url', { conversationId, urls })
  return res.urls ?? {}
})

/** Signed links for stored media urls of this conversation, keyed by stored url. Never rejects; urls that could not be linked are absent. */
export function resolveMediaUrls(conversationId: string, urls: readonly string[]): Promise<Map<string, string>> {
  return mediaLinks.resolve(conversationId, urls)
}

/**
 * `rows` with each private file's `media_url` swapped for its signed link (the
 * stored url is kept in `rawMediaUrl`). Never throws and never holds the rows
 * back for long: a message whose link is missing still renders, and the next
 * pass (App's relink) fills it in.
 */
export function resolveMessageMedia<T extends WidgetMessage>(conversationId: string, rows: T[]): Promise<T[]> {
  return resolveRowsMedia(conversationId, rows, mediaLinks)
}

export interface OutgoingMedia {
  path: string
  mimeType: string
  fileName: string
  sizeBytes: number
  kind: MediaKind
  durationSeconds?: number
}

export interface SentMessage {
  id: string
  created_at: string
  status: string
}

export async function sendWidgetMessage(
  conversationId: string,
  payload: { text?: string; media?: OutgoingMedia; clientMessageId?: string },
): Promise<SentMessage> {
  const res = await post<{ message: SentMessage }>('/api/widget/message', {
    conversationId,
    text: payload.text,
    media: payload.media,
    clientMessageId: payload.clientMessageId,
  })
  return res.message
}

// ---------- uploads ----------

/**
 * Uploads a media file straight to the server (POST /api/widget/upload)
 * which stores it via appStorage() and returns the path.
 * Returns the storage path to hand to /api/widget/message.
 */
export async function uploadMedia(
  conversationId: string,
  file: Blob,
  info: { fileName: string; mimeType: string; kind: MediaKind },
): Promise<string> {
  const token = await withTimeout(currentAccessToken())

  const form = new FormData()
  form.append('conversationId', conversationId)
  form.append('fileName', info.fileName)
  form.append('mimeType', info.mimeType)
  form.append('kind', info.kind)
  form.append('sizeBytes', String(file.size))
  form.append('file', file, info.fileName)

  let res: Response
  try {
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = setTimeout(() => controller?.abort(), REQUEST_TIMEOUT_MS)
    try {
      res = await fetch(`${API_ORIGIN}/api/widget/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
        signal: controller?.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  } catch {
    throw new ApiError('Network error', 0, 'network')
  }

  const data = (await res.json().catch(() => ({}))) as { path?: string; error?: string; code?: string }
  if (!res.ok) {
    throw new ApiError(
      data.error ?? `Upload failed (${res.status})`,
      res.status,
      data.code ?? 'upload_failed',
    )
  }
  if (!data.path) throw new ApiError('Upload returned no path', 500, 'upload_failed')
  return data.path
}

// ---------- receipts ----------

/** Best-effort: report AGENT messages the widget received / displayed. Never throws. */
export async function sendReceipt(
  conversationId: string,
  messageIds: string[],
  status: 'delivered' | 'read',
): Promise<boolean> {
  if (messageIds.length === 0) return true
  try {
    await post('/api/widget/receipt', { conversationId, messageIds, status })
    return true
  } catch {
    return false
  }
}
