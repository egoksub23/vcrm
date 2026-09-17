import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { RealtimeChannel } from '@supabase/supabase-js'

import { supabase, startSession, sendWidgetMessage, fetchMessageHistory } from './api'
import type { Branding, VerifiedIdentity, WidgetMessage } from './api'

interface LocalMessage extends WidgetMessage {
  pending?: boolean
  failed?: boolean
}

const LAUNCHER_ICON = (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
    <path
      d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
)
const CLOSE_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
    <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
  </svg>
)
const SEND_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
)

interface AppProps {
  widgetToken: string
  autoOpen?: boolean
  /** Synchronous handoff from the loader's own data-* attrs — set when
   *  the host app already knew the user before injecting the widget
   *  script. A present `.phone` skips the identity gate entirely. */
  initialIdentity?: VerifiedIdentity
  /** Registers the callback main.tsx's window.VircleWidget.identify()
   *  invokes for an ASYNC handoff (host auth finishes after mount). */
  onIdentifyReady?: (cb: (identity: VerifiedIdentity) => void) => void
}

export function App({ widgetToken, autoOpen = false, initialIdentity, onIdentifyReady }: AppProps) {
  const [open, setOpen] = useState(autoOpen)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [branding, setBranding] = useState<Branding | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<LocalMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  // null = not determined yet (still bootstrapping); true = this browser
  // is unidentified and the identity prompt must show; false = resolved
  // (guest or identified), normal composer shows.
  const [needsPhone, setNeedsPhone] = useState<boolean | null>(null)
  // 'ask' = "are you already a Vircle user?" yes/no; 'phone' = the
  // phone-entry form (after "yes", or answering a prior needsPhone).
  const [identityStage, setIdentityStage] = useState<'ask' | 'phone'>('ask')
  const [isGuest, setIsGuest] = useState(false)
  // Whether the "link your account" phone input is expanded — separate
  // from `linking` (the in-flight request state) so a failed attempt
  // leaves the form open with the typed number and the error visible,
  // instead of collapsing back to the toggle button.
  const [linkFormOpen, setLinkFormOpen] = useState(false)
  const [linking, setLinking] = useState(false)
  const [phoneInput, setPhoneInput] = useState('')
  const [nameInput, setNameInput] = useState('')
  const bootstrapped = useRef(false)
  const channelRef = useRef<RealtimeChannel | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Fetches history + opens the Realtime subscription for `id`, tearing
  // down any previous subscription first — reused not just by the
  // initial bootstrap but by every later re-identify (self-service
  // link, a late identify() call), where the conversationId can change
  // out from under an already-open chat if the visitor's guest history
  // gets merged into an existing contact's thread.
  const connectConversation = useCallback(async (id: string) => {
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current)
      channelRef.current = null
    }
    setConversationId(id)
    const history = await fetchMessageHistory(id)
    setMessages(history)

    const channel = supabase
      .channel(`widget-messages-${id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${id}` },
        (payload) => {
          const row = payload.new as WidgetMessage & { is_internal?: boolean; sender_type: string }
          // Our own sends are already rendered optimistically below —
          // only agent/bot replies need to be appended from Realtime.
          // is_internal is also excluded server-side by RLS (migration
          // 046), this is belt-and-braces.
          if (row.sender_type === 'customer' || row.is_internal) return
          setMessages((prev) => [...prev, row])
        },
      )
      .subscribe()
    channelRef.current = channel
  }, [])

  // Shared by every path that resolves (or re-resolves) identity:
  // initial bootstrap, the "yes" phone-gate submit, "no"/skip, a
  // mid-session "link your account", and an async identify() handoff.
  // Reconnects only when the conversationId actually changed (a guest
  // merge can land on a different, pre-existing conversation).
  const applyIdentity = useCallback(
    async (opts: Parameters<typeof startSession>[1]) => {
      const session = await startSession(widgetToken, opts)
      setBranding(session.branding)
      if (session.needsPhone) return session
      setNeedsPhone(false)
      setIsGuest(session.isGuest)
      if (session.conversationId !== conversationId) {
        await connectConversation(session.conversationId)
      }
      return session
    },
    [widgetToken, conversationId, connectConversation],
  )

  const bootstrap = useCallback(async () => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    setLoading(true)
    setError(null)
    try {
      const hasVerified = !!initialIdentity?.phone
      const session = await applyIdentity(hasVerified ? { verifiedIdentity: initialIdentity } : {})
      if (session.needsPhone) setNeedsPhone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      bootstrapped.current = false
    } finally {
      setLoading(false)
    }
  }, [initialIdentity, applyIdentity])

  const handleStartChat = useCallback(async () => {
    const phone = phoneInput.trim()
    if (!phone || loading) return
    setLoading(true)
    setError(null)
    try {
      const session = await applyIdentity({ visitorPhone: phone, visitorName: nameInput.trim() || undefined })
      if (session.needsPhone) setError('Enter a valid phone number')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }, [phoneInput, nameInput, loading, applyIdentity])

  const handleDecline = useCallback(async () => {
    if (loading) return
    setLoading(true)
    setError(null)
    try {
      await applyIdentity({ skipIdentity: true, visitorName: nameInput.trim() || undefined })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }, [loading, nameInput, applyIdentity])

  // "Link your account" — a guest visitor identifying themselves after
  // already chatting a while, not at the initial gate. Reuses the same
  // applyIdentity path; the backend does the guest -> known-contact
  // merge (migration 054) and applyIdentity's conversationId check
  // handles reconnecting to the (possibly different) merged thread.
  const handleLinkAccount = useCallback(async () => {
    const phone = phoneInput.trim()
    if (!phone || linking) return
    setLinking(true)
    setError(null)
    try {
      await applyIdentity({ visitorPhone: phone })
      setPhoneInput('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLinking(false)
    }
  }, [phoneInput, linking, applyIdentity])

  useEffect(() => {
    if (open) bootstrap()
  }, [open, bootstrap])

  // Async handoff — a host app whose own sign-in finishes after this
  // widget already mounted (and possibly already started a guest
  // session) calls window.VircleWidget.identify(...), which main.tsx
  // routes here.
  useEffect(() => {
    onIdentifyReady?.((identity) => {
      if (!identity.phone) return
      applyIdentity({ verifiedIdentity: identity }).catch((err) =>
        setError(err instanceof Error ? err.message : 'Something went wrong'),
      )
    })
  }, [onIdentifyReady, applyIdentity])

  useEffect(() => {
    return () => {
      if (channelRef.current) supabase.removeChannel(channelRef.current)
    }
  }, [])

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight })
  }, [messages, loading])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || !conversationId || sending) return
    const tempId = `temp-${Date.now()}`
    setMessages((prev) => [
      ...prev,
      { id: tempId, sender_type: 'customer', content_text: text, created_at: new Date().toISOString(), pending: true },
    ])
    setInput('')
    setSending(true)
    try {
      await sendWidgetMessage(conversationId, text)
      setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, pending: false } : m)))
    } catch {
      setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, pending: false, failed: true } : m)))
    } finally {
      setSending(false)
    }
  }, [input, conversationId, sending])

  const position = branding?.position ?? 'right'
  const primaryColor = branding?.primaryColor ?? '#3b82f6'

  return (
    <div class="wcw-root" style={{ '--wcw-primary': primaryColor } as Record<string, string>}>
      {open && (
        <div class={`wcw-panel wcw-${position}`}>
          <div class="wcw-header">
            <div class="wcw-header-avatar">
              {branding?.avatarUrl ? <img src={branding.avatarUrl} alt="" /> : (branding?.name ?? 'C').charAt(0).toUpperCase()}
            </div>
            <div class="wcw-header-title">{branding?.name ?? 'Chat'}</div>
            <button type="button" class="wcw-close" aria-label="Close chat" onClick={() => setOpen(false)}>
              {CLOSE_ICON}
            </button>
          </div>

          {error && <div class="wcw-error">{error}</div>}

          <div class="wcw-body" ref={bodyRef}>
            {branding?.welcomeMessage && <div class="wcw-welcome">{branding.welcomeMessage}</div>}
            {loading && messages.length === 0 && <div class="wcw-empty">Connecting…</div>}
            {messages.map((m) => (
              <div
                key={m.id}
                class={`wcw-bubble wcw-${m.sender_type === 'customer' ? 'customer' : 'agent'}${m.pending ? ' wcw-pending' : ''}${m.failed ? ' wcw-failed' : ''}`}
              >
                {m.content_text}
              </div>
            ))}
          </div>

          {needsPhone === true && identityStage === 'ask' && (
            <div class="wcw-gate">
              <p class="wcw-gate-hint">Are you already a Vircle user?</p>
              <div class="wcw-gate-row">
                <button
                  type="button"
                  class="wcw-gate-submit"
                  disabled={loading}
                  onClick={() => setIdentityStage('phone')}
                >
                  Yes
                </button>
                <button
                  type="button"
                  class="wcw-gate-secondary"
                  disabled={loading}
                  onClick={handleDecline}
                >
                  {loading ? 'Starting…' : "No, I'm just browsing"}
                </button>
              </div>
            </div>
          )}

          {needsPhone === true && identityStage === 'phone' && (
            <div class="wcw-gate">
              <p class="wcw-gate-hint">Enter your Vircle phone number to continue</p>
              <input
                type="tel"
                inputMode="tel"
                placeholder="Phone number, e.g. 601234455678"
                value={phoneInput}
                disabled={loading}
                onInput={(e) => setPhoneInput((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => e.key === 'Enter' && handleStartChat()}
              />
              <input
                type="text"
                placeholder="Your name (optional)"
                value={nameInput}
                disabled={loading}
                onInput={(e) => setNameInput((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => e.key === 'Enter' && handleStartChat()}
              />
              <button
                type="button"
                class="wcw-gate-submit"
                disabled={!phoneInput.trim() || loading}
                onClick={handleStartChat}
              >
                {loading ? 'Starting…' : 'Start chat'}
              </button>
            </div>
          )}

          {needsPhone === false && isGuest && (
            <div class="wcw-link-account">
              {linkFormOpen ? (
                <>
                  <input
                    type="tel"
                    inputMode="tel"
                    placeholder="Your phone number"
                    value={phoneInput}
                    disabled={linking}
                    onInput={(e) => setPhoneInput((e.target as HTMLInputElement).value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleLinkAccount()}
                  />
                  <button type="button" disabled={!phoneInput.trim() || linking} onClick={handleLinkAccount}>
                    {linking ? 'Linking…' : 'Link'}
                  </button>
                </>
              ) : (
                <button type="button" class="wcw-link-account-toggle" onClick={() => setLinkFormOpen(true)}>
                  Already a Vircle user? Link your account
                </button>
              )}
            </div>
          )}

          {needsPhone === false && (
            <div class="wcw-composer">
              <textarea
                class="wcw-input"
                placeholder="Type a message…"
                value={input}
                onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleSend()
                  }
                }}
                rows={1}
              />
              <button
                type="button"
                class="wcw-send"
                disabled={!input.trim() || sending || !conversationId}
                onClick={handleSend}
                aria-label="Send"
              >
                {SEND_ICON}
              </button>
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        class={`wcw-launcher wcw-${position}`}
        aria-label={open ? 'Close chat' : 'Open chat'}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? CLOSE_ICON : LAUNCHER_ICON}
      </button>
    </div>
  )
}
