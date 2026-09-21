// ============================================================
// Supabase client + the widget API calls:
//   POST /api/widget/session      identity + conversation bootstrap
//   POST /api/widget/enquiry      the "I have an enquiry" form
//   POST /api/widget/message      text and/or media
//   POST /api/widget/upload-url   signed upload token for chat-media
//   POST /api/widget/receipt      delivered / read reports for agent messages
// plus RLS reads of `messages` straight through the visitor's own
// Supabase client.
//
// SUPABASE_URL / SUPABASE_ANON_KEY are inlined at build time by
// esbuild's `define` (see ../../scripts/build-widget.mjs) — the exact
// same NEXT_PUBLIC_* values already public in the dashboard's own
// client bundle, so baking them into this one too is not a new
// exposure. There is no other way to get them: the widget has to
// authenticate an anonymous Supabase session BEFORE it can call our
// API at all, and that session needs a Supabase client already.
// ============================================================
import { createClient } from '@supabase/supabase-js'

import type {
  Branding,
  IdentityInfo,
  Locale,
  MediaKind,
  WidgetLimits,
  WidgetMessage,
} from './types'

declare const __SUPABASE_URL__: string
declare const __SUPABASE_ANON_KEY__: string

export const supabase = createClient(__SUPABASE_URL__, __SUPABASE_ANON_KEY__)

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

async function currentAccessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession()
  if (data.session?.access_token) return data.session.access_token
  const { data: signedIn, error } = await supabase.auth.signInAnonymously()
  if (error || !signedIn.session) {
    throw new ApiError(error?.message ?? 'Failed to start an anonymous session', 401, 'auth')
  }
  return signedIn.session.access_token
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const token = await currentAccessToken()
  let res: Response
  try {
    res = await fetch(`${API_ORIGIN}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })
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
  conversationId?: string
  identity?: IdentityInfo
  isGuest?: boolean
  identityError?: 'bad_identity_token' | 'expired_identity_token'
  claimFound?: boolean
  branding: Branding
  verification?: { mode: 'none' | 'email_code' | 'whatsapp_code' }
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

const MESSAGE_COLUMNS =
  'id, sender_type, content_text, content_type, media_url, status, created_at, is_internal'

export const HISTORY_PAGE_SIZE = 50

/**
 * History + live updates both go straight through the visitor's own
 * RLS-scoped Supabase client rather than a server route — the same
 * `messages_widget_visitor_select` policy (migration 046) that scopes
 * the Realtime subscription also scopes this plain SELECT, and
 * `is_internal IS NOT TRUE` there is what keeps a teammate's internal
 * comment out of both.
 *
 * Newest page first (`before` = created_at cursor of the oldest row
 * already shown for older pages); returned oldest-first for display.
 */
export async function fetchMessages(
  conversationId: string,
  before?: string,
): Promise<{ rows: WidgetMessage[]; hasMore: boolean }> {
  let q = supabase
    .from('messages')
    .select(MESSAGE_COLUMNS)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(HISTORY_PAGE_SIZE)
  if (before) q = q.lt('created_at', before)
  const { data, error } = await q
  if (error) throw new ApiError(error.message, 500, 'history')
  const rows = ((data ?? []) as unknown as WidgetMessage[]).filter((m) => !m.is_internal).reverse()
  return { rows, hasMore: (data ?? []).length >= HISTORY_PAGE_SIZE }
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

interface UploadUrlResponse {
  bucket: string
  path: string
  token: string
}

/**
 * Two steps: ask the server for a signed upload token (it validates
 * type / size and scopes the path to this conversation), then upload
 * straight to Storage with it — no file bytes pass through our API.
 * Returns the storage path to hand to /api/widget/message.
 */
export async function uploadMedia(
  conversationId: string,
  file: Blob,
  info: { fileName: string; mimeType: string; kind: MediaKind },
): Promise<string> {
  const slot = await post<UploadUrlResponse>('/api/widget/upload-url', {
    conversationId,
    fileName: info.fileName,
    mimeType: info.mimeType,
    sizeBytes: file.size,
    kind: info.kind,
  })
  const { error } = await supabase.storage
    .from(slot.bucket || 'chat-media')
    .uploadToSignedUrl(slot.path, slot.token, file, { contentType: info.mimeType })
  if (error) {
    throw new ApiError(error.message, 500, 'upload_failed')
  }
  return slot.path
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
