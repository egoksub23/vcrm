// ============================================================
// Supabase client + the two widget API calls
// (POST /api/widget/session, POST /api/widget/message).
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

declare const __SUPABASE_URL__: string
declare const __SUPABASE_ANON_KEY__: string

export const supabase = createClient(__SUPABASE_URL__, __SUPABASE_ANON_KEY__)

export interface Branding {
  name: string
  welcomeMessage: string
  primaryColor: string
  avatarUrl: string | null
  position: 'left' | 'right'
}

/** Identity a host app already verified (in-app/WebView embed) — hands
 *  the widget a known phone (and optionally a wallet id / email) so it
 *  never has to ask the visitor to type anything. See the matching
 *  comment in src/app/api/widget/session/route.ts. */
export interface VerifiedIdentity {
  phone?: string
  walletId?: string
  email?: string
}

export interface StartSessionOptions {
  visitorPhone?: string
  visitorName?: string
  verifiedIdentity?: VerifiedIdentity
  /** The visitor answered "no" to "are you already a Vircle user?" —
   *  starts a plain anonymous guest session. */
  skipIdentity?: boolean
}

export type SessionResult =
  | { needsPhone: true; branding: Branding }
  | { needsPhone: false; conversationId: string; isGuest: boolean; branding: Branding }

export interface WidgetMessage {
  id: string
  sender_type: 'customer' | 'agent' | 'bot'
  content_text: string | null
  created_at: string
}

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

async function currentAccessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession()
  if (data.session?.access_token) return data.session.access_token
  const { data: signedIn, error } = await supabase.auth.signInAnonymously()
  if (error || !signedIn.session) {
    throw new Error(error?.message ?? 'Failed to start an anonymous session')
  }
  return signedIn.session.access_token
}

/**
 * Identity protocol (see the matching comment in
 * src/app/api/widget/session/route.ts): call with none of
 * `verifiedIdentity` / `visitorPhone` / `skipIdentity` set first — a
 * brand-new browser gets back `needsPhone: true` instead of a
 * conversation, a returning one (already bound via widget_visitors)
 * gets a conversation immediately either way. `verifiedIdentity` (an
 * in-app/WebView host already knows the visitor) and `skipIdentity`
 * (visitor declined) both skip `needsPhone` entirely; `visitorPhone`
 * answers a prior `needsPhone: true` after the visitor typed it in.
 */
export async function startSession(
  widgetToken: string,
  opts: StartSessionOptions = {},
): Promise<SessionResult> {
  const token = await currentAccessToken()
  const res = await fetch(`${API_ORIGIN}/api/widget/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      widgetToken,
      visitorPhone: opts.visitorPhone,
      visitorName: opts.visitorName,
      verifiedIdentity: opts.verifiedIdentity,
      skipIdentity: opts.skipIdentity,
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to start chat session')
  return data as SessionResult
}

/**
 * History + live updates both go straight through the visitor's own
 * RLS-scoped Supabase client rather than a server route — the same
 * `messages_widget_visitor_select` policy (migration 046) that scopes
 * the Realtime subscription also scopes this plain SELECT, and
 * `is_internal IS NOT TRUE` there is what keeps a teammate's internal
 * comment out of both.
 */
export async function fetchMessageHistory(conversationId: string): Promise<WidgetMessage[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('id, sender_type, content_text, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(100)
  if (error) throw new Error(error.message)
  return (data ?? []) as WidgetMessage[]
}

export async function sendWidgetMessage(
  conversationId: string,
  text: string,
): Promise<void> {
  const token = await currentAccessToken()
  const res = await fetch(`${API_ORIGIN}/api/widget/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ conversationId, text }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error ?? 'Failed to send message')
  }
}
