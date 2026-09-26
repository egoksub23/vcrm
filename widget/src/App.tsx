import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { RealtimeChannel } from '@supabase/supabase-js'

import {
  ApiError,
  fetchMessages,
  sendEnquiry,
  sendReceipt,
  sendWidgetMessage,
  sessionNeedsIdentity,
  startSession,
  supabase,
  uploadMedia,
  verifyCode,
  type Claim,
  type EnquiryInput,
  type SessionResponse,
  type StartSessionOptions,
} from './api'
import { makeTranslator, type Translate } from './i18n'
import { canRecordVoice } from './recorder'
import type { VoiceResult } from './recorder-strategy'
import { isReturning, markReturning, readLastSeen, writeLastSeen } from './storage'
import {
  DEFAULT_LIMITS,
  type Branding,
  type IdentityInfo,
  type IdentityInput,
  type Locale,
  type LocalMessage,
  type MediaKind,
  type WidgetLimits,
} from './types'
import {
  findUnread,
  formatBytes,
  guessMime,
  historyLooksMissing,
  isTemp,
  mergeMessages,
  needsConnect,
  pollDelayMs,
  receiptTargets,
  safeGroupMessages,
  TEMP_PREFIX,
  toWidgetMessage,
  validateFile,
  type UnreadMarker,
} from './util'
import { Bubble } from './ui/Bubble'
import { Composer } from './ui/Composer'
import { ChoiceScreen, ClaimForm, EnquiryForm, VerifyCodeForm } from './ui/Gate'
import { ArrowDownIcon, BackIcon, CloseIcon, LauncherIcon } from './ui/icons'
import { Lightbox, MediaPreview, type StagedFile } from './ui/Overlays'

type Screen = 'boot' | 'error' | 'choice' | 'claim' | 'verify' | 'enquiry' | 'chat'
type Banner = { kind: 'error' | 'info'; text: string }

interface AppProps {
  widgetToken: string
  locale: Locale
  autoOpen?: boolean
  /** Synchronous handoff from the loader's own data-* attrs (token or legacy phone/email). */
  initialIdentity?: IdentityInput
  /** Registers the callback main.tsx's window.VircleWidget.identify() invokes for an
   *  ASYNC handoff (the host's own sign-in finishes after this widget mounted). */
  onIdentifyReady?: (cb: (identity: IdentityInput) => void) => void
}

let tempCounter = 0
function newTempId(): string {
  tempCounter += 1
  return `${TEMP_PREFIX}${Date.now().toString(36)}-${tempCounter}`
}

function errorText(err: unknown, t: Translate, limits: WidgetLimits): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'rate_limited':
        return t('rateLimited')
      case 'network':
        return t('networkError')
      case 'invalid_claim':
        return t('errClaim')
      case 'file_too_large':
        return t('fileTooLarge', { max: formatBytes(limits.maxFileBytes) })
      case 'file_type_not_allowed':
        return t('fileTypeNotAllowed')
      default:
        return t('genericError')
    }
  }
  return t('genericError')
}

function extensionFor(mime: string): string {
  if (mime === 'audio/ogg') return 'ogg'
  if (mime === 'audio/mp4') return 'm4a'
  if (mime === 'audio/aac') return 'aac'
  return 'audio'
}

export function App({ widgetToken, locale, autoOpen = false, initialIdentity, onIdentifyReady }: AppProps) {
  const t = useMemo(() => makeTranslator(locale), [locale])

  const [open, setOpen] = useState(autoOpen)
  const [screen, setScreen] = useState<Screen>('boot')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  const [banner, setBanner] = useState<Banner | null>(null)
  const [branding, setBranding] = useState<Branding | null>(null)
  const [limits, setLimits] = useState<WidgetLimits>(DEFAULT_LIMITS)
  const [identity, setIdentity] = useState<IdentityInfo | null>(null)
  // Masked email a verification code was just sent to (migration 110);
  // shown on the code-entry screen. The claim itself is kept so "Resend
  // code" can just resubmit it, same request as the first time.
  const [maskedDestination, setMaskedDestination] = useState<string | null>(null)
  const lastClaimRef = useRef<Claim | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<LocalMessage[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [historyReady, setHistoryReady] = useState(false)
  // The earlier messages could not be loaded (fetch failed, or came back empty for a returning visitor).
  const [historyError, setHistoryError] = useState(false)
  const [live, setLive] = useState(true)
  const [staged, setStaged] = useState<StagedFile | null>(null)
  const [lightbox, setLightbox] = useState<{ src: string; name: string } | null>(null)
  const [unread, setUnread] = useState<UnreadMarker | null>(null)
  const [lastSeen, setLastSeen] = useState<string | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  const [isMobile, setIsMobile] = useState(false)
  const [viewport, setViewport] = useState<{ height: string; top: string } | null>(null)
  const [initialScroll, setInitialScroll] = useState(0)
  const [canRecord, setCanRecord] = useState(() => canRecordVoice(DEFAULT_LIMITS.allowedMimeTypes))

  const bootstrapped = useRef(false)
  const channelRef = useRef<RealtimeChannel | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const convRef = useRef<string | null>(null)
  // Set only once history was attempted AND the live channel is open; see needsConnect().
  const connectedRef = useRef<string | null>(null)
  const messagesRef = useRef<LocalMessage[]>([])
  const hasMoreRef = useRef(false)
  const loadingOlderRef = useRef(false)
  const lastSeenRef = useRef<string | null>(null)
  const stickRef = useRef(true)
  const anchorRef = useRef<{ height: number; top: number } | null>(null)
  const snapshotDone = useRef(false)
  const everSubscribed = useRef(false)
  const reported = useRef(new Map<string, 'delivered' | 'read'>())
  const identityRef = useRef<IdentityInput>({ ...initialIdentity })
  const identityLevelRef = useRef<string | null>(null)
  const limitsRef = useRef(limits)
  limitsRef.current = limits
  messagesRef.current = messages
  hasMoreRef.current = hasMore
  identityLevelRef.current = identity?.level ?? null

  // ---------- conversation connection ----------

  const refreshLatest = useCallback(async () => {
    const id = convRef.current
    if (!id) return
    try {
      const { rows } = await fetchMessages(id)
      if (convRef.current !== id) return
      setMessages((prev) => mergeMessages(prev, rows))
      if (rows.length > 0) setHistoryError(false)
    } catch {
      /* the next poll / reconnect / visibility change retries */
    }
  }, [])

  // The Try again button under a failed history load: fetches the newest page again.
  const retryHistory = useCallback(async () => {
    const id = convRef.current
    if (!id) return
    setHistoryError(false)
    try {
      const { rows, hasMore: more } = await fetchMessages(id)
      if (convRef.current !== id) return
      setMessages((prev) => mergeMessages(prev, rows))
      setHasMore((prev) => prev || more)
      setHistoryError(historyLooksMissing(rows.length, lastSeenRef.current))
    } catch {
      if (convRef.current === id) setHistoryError(true)
    }
  }, [])

  // Fetches the newest page + opens the Realtime subscription for `id`,
  // tearing down any previous one first — reused by the initial
  // bootstrap and by every later re-identify, where the conversationId
  // can change out from under an open chat if a guest thread is merged
  // into an existing contact's.
  const connectConversation = useCallback(async (id: string) => {
    if (channelRef.current) {
      void supabase.removeChannel(channelRef.current)
      channelRef.current = null
    }
    convRef.current = id
    connectedRef.current = null
    everSubscribed.current = false
    reported.current = new Map()
    snapshotDone.current = false
    setConversationId(id)
    setHistoryReady(false)
    setHistoryError(false)
    setUnread(null)
    setMessages([])
    lastSeenRef.current = readLastSeen(id)
    setLastSeen(lastSeenRef.current)

    // Live channel first, then history: a message sent in between is merged, never lost.
    const filter = `conversation_id=eq.${id}`
    try {
      const channel = supabase
        .channel(`widget-messages-${id}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter }, (payload) => {
          const row = toWidgetMessage(payload.new as Record<string, unknown>)
          // is_internal is also excluded server-side by RLS (migration 046) - belt and braces.
          if (!row || row.is_internal) return
          setMessages((prev) => {
            if (row.sender_type === 'customer') {
              // The visitor's own sends are rendered optimistically and reconciled
              // from the /message response; only adopt one that this browser is
              // not in the middle of sending (e.g. sent from another tab).
              if (prev.some((m) => m.id === row.id)) return mergeMessages(prev, [row])
              if (prev.some((m) => isTemp(m) && m.pending)) return prev
            }
            return mergeMessages(prev, [row])
          })
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter }, (payload) => {
          const row = toWidgetMessage(payload.new as Record<string, unknown>)
          if (!row || row.is_internal) return
          // Animates the ticks; mergeMessages never lets a status go backwards.
          setMessages((prev) => (prev.some((m) => m.id === row.id) ? mergeMessages(prev, [row]) : prev))
        })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            setLive(true)
            // Anything sent while the socket was down is fetched now.
            if (everSubscribed.current) void refreshLatest()
            everSubscribed.current = true
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            setLive(false)
          }
        })
      channelRef.current = channel
    } catch {
      setLive(false) // the poll below still keeps the chat current
    }

    try {
      const { rows, hasMore: more } = await fetchMessages(id)
      if (convRef.current !== id) return
      setMessages((prev) => mergeMessages(prev, rows))
      setHasMore(more)
      setHistoryError(historyLooksMissing(rows.length, lastSeenRef.current))
    } catch {
      // Never throw out of here: the chat opens anyway, with an error and a retry
      // under it, instead of a blank or "new" looking conversation.
      if (convRef.current !== id) return
      setHistoryError(true)
    }
    setHistoryReady(true)
    connectedRef.current = id
  }, [refreshLatest])

  // Shared by every path that resolves (or re-resolves) identity.
  // Returns true when the visitor ended up in a conversation.
  const applySession = useCallback(
    async (res: SessionResponse, announce = false): Promise<boolean> => {
      setBranding(res.branding)
      if (res.limits) {
        setLimits(res.limits)
        setCanRecord(canRecordVoice(res.limits.allowedMimeTypes))
      }
      if (res.identity) setIdentity(res.identity)
      if (res.identityError) {
        // The token was rejected; the visitor simply continues unidentified. Tell the
        // host page (its dev console / analytics) so a bad integration is visible.
        console.warn(`[vircle-widget] identity token rejected: ${res.identityError}`)
        window.dispatchEvent(new CustomEvent('vircle-widget:identity-error', { detail: { code: res.identityError } }))
      }
      if (res.needsVerification) {
        // A matched claim just got an emailed code (migration 110):
        // not a chat yet, and not an error either — the code-entry
        // screen is the expected next step.
        setMaskedDestination(res.verification?.maskedEmail ?? null)
        setScreen('verify')
        return true
      }
      if (sessionNeedsIdentity(res) || !res.conversationId) {
        // Coming from the claim/verify forms, a "could not identify you"
        // answer stays right there so the caller's own formError shows
        // next to the field the visitor is looking at; anywhere else
        // (a stale/rejected token on boot, for instance) falls back to
        // the top-level choice screen.
        if (screen !== 'claim' && screen !== 'verify') setScreen('choice')
        return false
      }
      if (needsConnect(res.conversationId, connectedRef.current)) await connectConversation(res.conversationId)
      setScreen('chat')
      markReturning(widgetToken)
      if (announce && res.claimFound !== undefined) {
        const name = res.identity?.displayName
        setBanner({
          kind: 'info',
          text: res.claimFound
            ? name
              ? t('welcomeBack', { name })
              : t('welcomeBackNoName')
            : t('welcomeNew'),
        })
      }
      return true
    },
    [connectConversation, screen, t, widgetToken],
  )

  const bootstrap = useCallback(async () => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    setBootError(null)
    try {
      const idn = identityRef.current
      const opts: StartSessionOptions = { locale }
      if (idn.token) opts.identityToken = idn.token
      else if (idn.phone || idn.email) opts.claim = { phone: idn.phone, email: idn.email, name: idn.name }
      await applySession(await startSession(widgetToken, opts))
    } catch (err) {
      bootstrapped.current = false
      setBootError(errorText(err, t, limitsRef.current))
      setScreen('error')
    }
  }, [applySession, locale, t, widgetToken])

  // Open the chat -> bootstrap. A browser that has chatted before also connects quietly
  // on page load, so the launcher can show an unread badge for replies that arrived
  // while the visitor was away.
  useEffect(() => {
    if (open || isReturning(widgetToken)) void bootstrap()
  }, [open, bootstrap, widgetToken])

  const runIdentity = useCallback(
    async (opts: StartSessionOptions) => {
      try {
        await applySession(await startSession(widgetToken, { locale, ...opts }))
      } catch (err) {
        setBanner({ kind: 'error', text: errorText(err, t, limitsRef.current) })
      }
    },
    [applySession, locale, t, widgetToken],
  )

  // Late handoff from window.VircleWidget.identify(...).
  useEffect(() => {
    onIdentifyReady?.((next) => {
      identityRef.current = { ...identityRef.current, ...next }
      if (!bootstrapped.current) return // picked up by bootstrap()
      if (next.token) {
        void runIdentity({ identityToken: next.token })
      } else if ((next.phone || next.email) && identityLevelRef.current !== 'verified') {
        void runIdentity({ claim: { phone: next.phone, email: next.email, name: next.name } })
      }
    })
  }, [onIdentifyReady, runIdentity])

  // ---------- form handlers ----------

  const handleClaim = useCallback(
    async (claim: Claim) => {
      lastClaimRef.current = claim
      setBusy(true)
      setFormError(null)
      try {
        const res = await startSession(widgetToken, { claim, locale })
        const ok = await applySession(res, true)
        if (!ok) setFormError(t('errClaim'))
      } catch (err) {
        setFormError(errorText(err, t, limitsRef.current))
      } finally {
        setBusy(false)
      }
    },
    [applySession, locale, t, widgetToken],
  )

  // "Resend code": literally resubmit the same claim, which the server
  // answers by overwriting the previous pending code (migration 110's
  // widget_verification_codes is keyed one row per browser) — no
  // separate resend endpoint needed.
  const handleResendCode = useCallback(() => {
    if (lastClaimRef.current) void handleClaim(lastClaimRef.current)
  }, [handleClaim])

  const handleVerifyCode = useCallback(
    async (code: string) => {
      setBusy(true)
      setFormError(null)
      try {
        const res = await verifyCode(code)
        const ok = await applySession(res, true)
        if (!ok) setFormError(t('errVerifyCode'))
      } catch (err) {
        // A wrong/expired code, too many attempts, or no verification in
        // progress all come back as `bad_request` — one clear message
        // covers all of them here rather than surfacing raw server text.
        if (err instanceof ApiError && err.code === 'bad_request') setFormError(t('errVerifyCode'))
        else setFormError(errorText(err, t, limitsRef.current))
      } finally {
        setBusy(false)
      }
    },
    [applySession, t],
  )

  const handleEnquiry = useCallback(
    async (input: Omit<EnquiryInput, 'locale'>) => {
      setBusy(true)
      setFormError(null)
      try {
        const res = await sendEnquiry(widgetToken, { ...input, locale })
        const ok = await applySession(res)
        if (ok) setBanner({ kind: 'info', text: t('enquirySent') })
        else setFormError(t('genericError'))
      } catch (err) {
        setFormError(errorText(err, t, limitsRef.current))
      } finally {
        setBusy(false)
      }
    },
    [applySession, locale, t, widgetToken],
  )

  const handleGuest = useCallback(async () => {
    setBusy(true)
    try {
      await applySession(await startSession(widgetToken, { skipIdentity: true, locale }))
    } catch (err) {
      setBanner({ kind: 'error', text: errorText(err, t, limitsRef.current) })
    } finally {
      setBusy(false)
    }
  }, [applySession, locale, t, widgetToken])

  // ---------- sending ----------

  const performSend = useCallback(
    async (draft: LocalMessage) => {
      const convId = convRef.current
      if (!convId) return
      setMessages((prev) => prev.map((m) => (m.id === draft.id ? { ...m, pending: true, failed: false } : m)))
      try {
        let media
        const file = draft.retry?.file
        if (file) {
          const kind = draft.retry?.kind ?? 'document'
          const mime = guessMime(file)
          const path = await uploadMedia(convId, file, { fileName: file.name, mimeType: mime, kind })
          media = {
            path,
            mimeType: mime,
            fileName: file.name,
            sizeBytes: file.size,
            kind,
            durationSeconds: draft.retry?.durationSeconds,
          }
        }
        const sent = await sendWidgetMessage(convId, {
          text: draft.retry?.text || undefined,
          media,
          clientMessageId: draft.id,
        })
        if (convRef.current !== convId) return
        const settled: LocalMessage = {
          ...draft,
          id: sent.id,
          created_at: sent.created_at,
          status: sent.status,
          pending: false,
          failed: false,
          retry: undefined,
        }
        setMessages((prev) => mergeMessages(prev.filter((m) => m.id !== draft.id), [settled]))
      } catch (err) {
        setMessages((prev) => prev.map((m) => (m.id === draft.id ? { ...m, pending: false, failed: true } : m)))
        if (err instanceof ApiError && ['rate_limited', 'file_too_large', 'file_type_not_allowed', 'network'].includes(err.code ?? '')) {
          setBanner({ kind: 'error', text: errorText(err, t, limitsRef.current) })
        }
      }
    },
    [t],
  )

  const enqueue = useCallback(
    (draft: Omit<LocalMessage, 'id' | 'sender_type' | 'created_at' | 'pending'>) => {
      const msg: LocalMessage = {
        ...draft,
        id: newTempId(),
        sender_type: 'customer',
        created_at: new Date().toISOString(),
        status: 'sent',
        pending: true,
      }
      stickRef.current = true
      setMessages((prev) => [...prev, msg])
      void performSend(msg)
    },
    [performSend],
  )

  const sendText = useCallback(
    (text: string) => enqueue({ content_text: text, content_type: 'text', retry: { text } }),
    [enqueue],
  )

  const sendFile = useCallback(
    (file: File, kind: MediaKind, caption: string, url: string, durationSeconds?: number) =>
      enqueue({
        content_text: caption || null,
        content_type: kind,
        localUrl: url,
        localFileName: file.name,
        localSizeBytes: file.size,
        localDurationSeconds: durationSeconds ?? null,
        retry: { text: caption || undefined, file, kind, durationSeconds },
      }),
    [enqueue],
  )

  const handleFileChosen = useCallback(
    (file: File) => {
      const check = validateFile(file, limitsRef.current)
      if (!check.ok) {
        setBanner({
          kind: 'error',
          text:
            check.reason === 'too_large'
              ? t('fileTooLarge', { max: formatBytes(limitsRef.current.maxFileBytes) })
              : t('fileTypeNotAllowed'),
        })
        return
      }
      setStaged({ file, kind: check.kind, mime: check.mime, url: URL.createObjectURL(file) })
    },
    [t],
  )

  const confirmStaged = useCallback(
    (caption: string) => {
      if (!staged) return
      // The preview's blob URL becomes the bubble's until the server row arrives.
      sendFile(staged.file, staged.kind, caption, staged.url)
      setStaged(null)
    },
    [staged, sendFile],
  )

  const cancelStaged = useCallback(() => {
    setStaged((s) => {
      if (s) URL.revokeObjectURL(s.url)
      return null
    })
  }, [])

  const handleVoice = useCallback(
    (result: VoiceResult) => {
      const file = new File([result.blob], `voice-${Date.now()}.${extensionFor(result.mimeType)}`, {
        type: result.mimeType,
      })
      const seconds = Math.max(1, Math.round(result.durationSeconds))
      sendFile(file, 'audio', '', URL.createObjectURL(file), seconds)
    },
    [sendFile],
  )

  const retry = useCallback(
    (m: LocalMessage) => {
      if (m.failed) void performSend(m)
    },
    [performSend],
  )

  // ---------- history pagination ----------

  const loadOlder = useCallback(async () => {
    const id = convRef.current
    if (!id || loadingOlderRef.current || !hasMoreRef.current) return
    const oldest = messagesRef.current.find((m) => !isTemp(m))
    if (!oldest) return
    loadingOlderRef.current = true
    setLoadingOlder(true)
    try {
      const { rows, hasMore: more } = await fetchMessages(id, oldest.created_at)
      if (convRef.current !== id) return
      const el = bodyRef.current
      anchorRef.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null
      setMessages((prev) => mergeMessages(prev, rows))
      setHasMore(more)
    } catch {
      setBanner({ kind: 'error', text: t('networkError') })
    } finally {
      loadingOlderRef.current = false
      setLoadingOlder(false)
    }
  }, [t])

  // ---------- scrolling ----------

  const onScroll = useCallback(() => {
    const el = bodyRef.current
    if (!el) return
    const away = el.scrollHeight - el.scrollTop - el.clientHeight
    stickRef.current = away < 80
    setAtBottom(away < 80)
    if (el.scrollTop < 60) void loadOlder()
  }, [loadOlder])

  // A photo/video finishing its load makes its bubble taller — stay at the bottom if we were.
  const keepPinned = useCallback(() => {
    const el = bodyRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = bodyRef.current
    if (el) el.scrollTo({ top: el.scrollHeight })
  }, [])

  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    if (anchorRef.current) {
      // Older messages were prepended: keep what the visitor was reading in place.
      el.scrollTop = el.scrollHeight - anchorRef.current.height + anchorRef.current.top
      anchorRef.current = null
      return
    }
    if (stickRef.current) el.scrollTop = el.scrollHeight
  }, [messages, screen, staged, banner])

  // First time the panel shows a loaded conversation: freeze the unread marker
  // (relative to what the visitor had seen before), then jump to it.
  useLayoutEffect(() => {
    if (!open || !historyReady || screen !== 'chat' || snapshotDone.current) return
    snapshotDone.current = true
    setUnread(findUnread(messagesRef.current, lastSeenRef.current))
    setInitialScroll((n) => n + 1)
  }, [open, historyReady, screen])

  useLayoutEffect(() => {
    if (initialScroll === 0) return
    const el = bodyRef.current
    if (!el) return
    const marker = el.querySelector('.wcw-unread') as HTMLElement | null
    if (marker) {
      stickRef.current = false
      // Position of the marker inside the scroller (offsetTop would be relative to the panel).
      const offset = marker.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
      el.scrollTop = Math.max(0, offset - 48)
    } else {
      stickRef.current = true
      el.scrollTop = el.scrollHeight
    }
  }, [initialScroll])

  useEffect(() => {
    if (!open) {
      snapshotDone.current = false
      setUnread(null)
      setLightbox(null)
    }
  }, [open])

  // Anything on screen counts as seen: remembered per conversation so the next
  // visit can mark what arrived in between.
  useEffect(() => {
    const id = convRef.current
    if (!id || !open || !visible || !historyReady) return
    let newest = lastSeenRef.current
    for (const m of messages) {
      if (isTemp(m)) continue
      if (!newest || Date.parse(m.created_at) > Date.parse(newest)) newest = m.created_at
    }
    if (newest && newest !== lastSeenRef.current) {
      lastSeenRef.current = newest
      writeLastSeen(id, newest)
      setLastSeen(newest)
    }
  }, [messages, open, visible, historyReady])

  const badgeCount = !open ? (findUnread(messages, lastSeen)?.count ?? 0) : 0

  // ---------- receipts: delivered as soon as received, read once displayed ----------

  useEffect(() => {
    const id = conversationId
    if (!id || !historyReady) return
    const report = (target: 'delivered' | 'read') => {
      const ids = receiptTargets(messages, reported.current, target)
      if (ids.length === 0) return
      for (const mid of ids) reported.current.set(mid, target)
      void sendReceipt(id, ids, target).then((ok) => {
        if (!ok) for (const mid of ids) if (reported.current.get(mid) === target) reported.current.delete(mid)
      })
    }
    if (open && visible && screen === 'chat') report('read')
    else report('delivered')
  }, [messages, conversationId, historyReady, open, visible, screen])

  // ---------- environment ----------

  // Safety net under Realtime: a quiet poll for anything a dropped or stale socket missed.
  useEffect(() => {
    const delay = pollDelayMs({ open, visible, live })
    if (delay === null || screen !== 'chat') return
    const id = window.setInterval(() => void refreshLatest(), delay)
    return () => window.clearInterval(id)
  }, [open, visible, live, screen, refreshLatest])

  useEffect(() => {
    const onOnline = () => void refreshLatest()
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [refreshLatest])

  useEffect(() => {
    const onVis = () => {
      const now = document.visibilityState !== 'hidden'
      setVisible(now)
      if (now) void refreshLatest()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [refreshLatest])

  useEffect(() => {
    let mq: MediaQueryList
    try {
      mq = window.matchMedia('(max-width: 600px)')
    } catch {
      return
    }
    const update = () => setIsMobile(mq.matches)
    update()
    mq.addEventListener?.('change', update)
    return () => mq.removeEventListener?.('change', update)
  }, [])

  // On phones the panel is full screen; follow the visual viewport so the
  // on-screen keyboard does not cover the composer.
  useEffect(() => {
    const vv = window.visualViewport
    if (!open || !isMobile || !vv) {
      setViewport(null)
      return
    }
    const update = () => setViewport({ height: `${vv.height}px`, top: `${vv.offsetTop}px` })
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [open, isMobile])

  useEffect(() => {
    if (!banner || banner.kind === 'error') return
    const id = window.setTimeout(() => setBanner(null), 7000)
    return () => window.clearTimeout(id)
  }, [banner])

  useEffect(
    () => () => {
      if (channelRef.current) void supabase.removeChannel(channelRef.current)
      for (const m of messagesRef.current) if (m.localUrl) URL.revokeObjectURL(m.localUrl)
    },
    [],
  )

  // ---------- render ----------

  const position = branding?.position ?? 'right'
  const primaryColor = branding?.primaryColor ?? '#3b82f6'
  const showBack = screen === 'claim' || screen === 'verify' || screen === 'enquiry'
  const items = useMemo(
    () => safeGroupMessages(messages, { locale, now: new Date(), t, unread }),
    [messages, locale, t, unread],
  )
  const panelStyle =
    isMobile && viewport ? ({ height: viewport.height, top: viewport.top } as Record<string, string>) : undefined

  const goBack = () => {
    setFormError(null)
    // From the code screen, "back" means "use a different number" —
    // straight to the claim form, not all the way out to the top-level
    // choice — the visitor's most likely next move.
    setScreen(screen === 'verify' ? 'claim' : conversationId ? 'chat' : 'choice')
  }

  return (
    <div
      class="wcw-root"
      lang={locale}
      style={{ '--wcw-primary': primaryColor } as Record<string, string>}
    >
      {open && (
        <div class={`wcw-panel wcw-${position}${isMobile ? ' wcw-mobile' : ''}`} style={panelStyle}>
          <div class="wcw-header">
            {showBack && (
              <button type="button" class="wcw-close" aria-label={t('back')} onClick={goBack}>
                <BackIcon />
              </button>
            )}
            <div class="wcw-header-avatar">
              {branding?.avatarUrl ? (
                <img src={branding.avatarUrl} alt="" />
              ) : (
                (branding?.name ?? 'C').charAt(0).toUpperCase()
              )}
            </div>
            <div class="wcw-header-text">
              <div class="wcw-header-title">{branding?.name ?? 'Chat'}</div>
              {screen === 'chat' && !live && <div class="wcw-header-sub">{t('reconnecting')}</div>}
            </div>
            <button type="button" class="wcw-close" aria-label={t('closeChat')} onClick={() => setOpen(false)}>
              <CloseIcon />
            </button>
          </div>

          {banner && (
            <div
              class={`wcw-banner wcw-banner-${banner.kind}`}
              role={banner.kind === 'error' ? 'alert' : 'status'}
              onClick={() => setBanner(null)}
            >
              {banner.text}
            </div>
          )}

          <div class={`wcw-body${screen === 'chat' ? ' wcw-body-chat' : ''}`} ref={bodyRef} onScroll={onScroll}>
            {screen === 'boot' && <div class="wcw-empty">{t('loadingChat')}</div>}

            {screen === 'error' && (
              <div class="wcw-empty">
                <p>{bootError}</p>
                <button
                  type="button"
                  class="wcw-primary"
                  onClick={() => {
                    setScreen('boot')
                    void bootstrap()
                  }}
                >
                  {t('retry')}
                </button>
              </div>
            )}

            {screen === 'choice' && (
              <>
                {branding?.welcomeMessage && <div class="wcw-welcome">{branding.welcomeMessage}</div>}
                <ChoiceScreen
                  t={t}
                  busy={busy}
                  onExisting={() => {
                    setFormError(null)
                    setScreen('claim')
                  }}
                  onEnquiry={() => {
                    setFormError(null)
                    setScreen('enquiry')
                  }}
                  onGuest={() => void handleGuest()}
                />
              </>
            )}

            {screen === 'claim' && <ClaimForm t={t} busy={busy} error={formError} onSubmit={handleClaim} />}
            {screen === 'verify' && (
              <VerifyCodeForm
                t={t}
                busy={busy}
                error={formError}
                maskedDestination={maskedDestination}
                onSubmit={handleVerifyCode}
                onResend={handleResendCode}
                onBack={goBack}
              />
            )}
            {screen === 'enquiry' && <EnquiryForm t={t} busy={busy} error={formError} onSubmit={handleEnquiry} />}

            {screen === 'chat' && (
              <>
                {hasMore && (
                  <button type="button" class="wcw-linkbtn wcw-earlier" onClick={() => void loadOlder()} disabled={loadingOlder}>
                    {loadingOlder ? t('loadingEarlier') : t('loadEarlier')}
                  </button>
                )}
                {!hasMore && branding?.welcomeMessage && <div class="wcw-welcome">{branding.welcomeMessage}</div>}
                {historyError && (
                  <div class="wcw-history-error" role="alert">
                    <span>{t('historyFailed')}</span>
                    <button type="button" class="wcw-linkbtn" onClick={() => void retryHistory()}>
                      {t('retry')}
                    </button>
                  </div>
                )}
                {historyReady && !historyError && messages.length === 0 && (
                  <div class="wcw-empty wcw-empty-inline">{t('emptyChat')}</div>
                )}
                {items.map((item) => {
                  if (item.type === 'day') {
                    return (
                      <div key={item.key} class="wcw-day">
                        <span>{item.label}</span>
                      </div>
                    )
                  }
                  if (item.type === 'unread') {
                    return (
                      <div key={item.key} class="wcw-unread">
                        <span>{item.count === 1 ? t('unreadOne') : t('unreadMany', { n: item.count })}</span>
                      </div>
                    )
                  }
                  return (
                    <Bubble
                      key={item.key}
                      m={item.message}
                      locale={locale}
                      t={t}
                      onRetry={retry}
                      onOpenImage={(src, name) => setLightbox({ src, name })}
                      onMediaLoad={keepPinned}
                    />
                  )
                })}
              </>
            )}
          </div>

          {screen === 'chat' && !atBottom && (
            <button type="button" class="wcw-jump" onClick={scrollToBottom} aria-label="↓">
              <ArrowDownIcon />
            </button>
          )}

          {screen === 'chat' && identity?.level === 'guest' && (
            <div class="wcw-link-account">
              <button
                type="button"
                class="wcw-linkbtn"
                onClick={() => {
                  setFormError(null)
                  setScreen('claim')
                }}
              >
                {t('linkAccount')}
              </button>
            </div>
          )}

          {screen === 'chat' && (
            <Composer
              t={t}
              limits={limits}
              disabled={!conversationId}
              canRecord={canRecord}
              onSendText={sendText}
              onFileChosen={handleFileChosen}
              onSendVoice={handleVoice}
              onError={(text) => setBanner({ kind: 'error', text })}
            />
          )}

          {staged && <MediaPreview staged={staged} t={t} onSend={confirmStaged} onCancel={cancelStaged} />}
          {lightbox && <Lightbox src={lightbox.src} name={lightbox.name} t={t} onClose={() => setLightbox(null)} />}
        </div>
      )}

      <button
        type="button"
        class={`wcw-launcher wcw-${position}${open && isMobile ? ' wcw-hidden' : ''}`}
        aria-label={open ? t('closeChat') : t('openChat')}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <CloseIcon size={22} /> : <LauncherIcon />}
        {!open && badgeCount > 0 && (
          <span class="wcw-badge" aria-label={String(badgeCount)}>
            {badgeCount > 9 ? '9+' : badgeCount}
          </span>
        )}
      </button>
    </div>
  )
}
