import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { RealtimeChannel } from '@supabase/supabase-js'

import { supabase, startSession, sendWidgetMessage, fetchMessageHistory } from './api'
import type { Branding, WidgetMessage } from './api'

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

export function App({ widgetToken }: { widgetToken: string }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [branding, setBranding] = useState<Branding | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<LocalMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [visitorName, setVisitorName] = useState('')
  const [showNameBar, setShowNameBar] = useState(true)
  const bootstrapped = useRef(false)
  const channelRef = useRef<RealtimeChannel | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  const bootstrap = useCallback(async () => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    setLoading(true)
    setError(null)
    try {
      const session = await startSession(widgetToken)
      setBranding(session.branding)
      setConversationId(session.conversationId)
      const history = await fetchMessageHistory(session.conversationId)
      setMessages(history)

      const channel = supabase
        .channel(`widget-messages-${session.conversationId}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'messages',
            filter: `conversation_id=eq.${session.conversationId}`,
          },
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      bootstrapped.current = false
    } finally {
      setLoading(false)
    }
  }, [widgetToken])

  useEffect(() => {
    if (open) bootstrap()
  }, [open, bootstrap])

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

  const handleSaveName = useCallback(async () => {
    const name = visitorName.trim()
    setShowNameBar(false)
    if (!name) return
    try {
      await startSession(widgetToken, name)
    } catch {
      /* best-effort — the conversation already works without a name */
    }
  }, [visitorName, widgetToken])

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

          {showNameBar && (
            <div class="wcw-namebar">
              <input
                type="text"
                placeholder="Your name (optional)"
                value={visitorName}
                onInput={(e) => setVisitorName((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSaveName()}
              />
              <button type="button" onClick={handleSaveName}>
                Save
              </button>
            </div>
          )}

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
