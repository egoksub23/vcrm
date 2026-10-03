// ============================================================
// The Vircle Chat client (work package 5). One object per signed-in user. It owns the connection to the gateway
// and keeps an ordered list of messages, each with a status, so the chat screen only has to draw them.
//
//   * CONNECT       asks the app's backend for a session, opens the WebSocket, says hello with the highest message
//                   number it holds, and takes what it missed.
//   * STAY          answers nothing to the server's pings (the browser does), sends its own ping and treats a missing
//                   pong as a dead connection; reconnects with growing, randomised waits; reconnects at once when the
//                   network returns or the app comes to the foreground.
//   * SEND          text and files get an id before anything is sent, so a message sent twice is stored once. While
//                   offline they wait and go out, in order, on the next connection. A text written but not yet stored
//                   survives closing the app.
//   * RECEIVE       de-duplicated and ordered by sequence number; a message that quotes another carries the quote.
//   * TICKS         "delivered" is reported for every message from support as it arrives; "read" while the chat screen
//                   is open. The user's own messages move from sent to delivered to read as support receives and reads them.
//   * TYPING        the user's typing is sent at most every 2.5 s; support's typing shows for 6 s.
//
// The frames are in docs/vircle-chat-app-protocol.md. Nothing here depends on a framework.
// ============================================================

import { backoffDelay, baseMime, DEFAULT_BACKOFF, DEFAULT_FILE_MAX_BYTES, Emitter, kindOfMime, MAX_VOICE_SECONDS, memoryStore } from './support'
import {
  ChatError,
  type ChatErrorInfo,
  type ChatMedia,
  type ChatMessage,
  type ChatSnapshot,
  type ChatStore,
  type ClientEvents,
  type ClientOptions,
  type ConnectionState,
  type Limits,
  type MessageKind,
  type MessageStatus,
  type Quote,
  type Session,
  type StoredState,
  type WebSocketLike,
} from './types'

const TYPING_SEND_INTERVAL_MS = 2500
const TYPING_SHOWN_MS = 6000
const CONNECT_TIMEOUT_MS = 15_000
const RECEIPT_DEBOUNCE_MS = 50
const PERSIST_DEBOUNCE_MS = 300
const KEEP_MESSAGES = 200
const MAX_QUEUED = 50
const LINK_REFRESH_MARGIN_MS = 60_000
const MAX_UPLOAD_ATTEMPTS = 3
const WS_OPEN = 1

const STATUS_ORDER: MessageStatus[] = ['sending', 'sent', 'delivered', 'read']

interface FileTask {
  blob: Blob
  fileName: string | null
  mimeType: string
  sizeBytes: number
  durationSeconds: number | null
  /** Set once the bytes are uploaded. */
  fileId: string | null
  attempts: number
  running: boolean
}

interface Pending {
  id: string
  kind: MessageKind
  text: string | null
  replyToServerId: string | null
  file: FileTask | null
  /** Sent on the current connection and waiting for the acknowledgement. */
  inflight: boolean
  rateTimer: ReturnType<typeof setTimeout> | null
  resolve: (m: ChatMessage) => void
  reject: (e: ChatError) => void
}

interface Waiter {
  resolve: (frame: Record<string, unknown>) => void
  reject: (e: ChatError) => void
  timer: ReturnType<typeof setTimeout>
}

const randomId = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return `c-${c.randomUUID()}`
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export class VircleChatClient {
  private readonly emitter = new Emitter<ClientEvents>()
  private readonly opts: ClientOptions
  private readonly store: ChatStore
  private readonly backoff = DEFAULT_BACKOFF
  private readonly now: () => number

  // state
  private state: ConnectionState = 'idle'
  private nextAttemptAt: number | null = null
  private messages: ChatMessage[] = []
  private readonly byId = new Map<string, ChatMessage>()
  private readonly byServerId = new Map<string, ChatMessage>()
  private supportTyping = false
  private loaded = false
  private limits: Limits | null = null
  private conversationId: string | null = null
  private lastSeq = 0
  private lastError: ChatErrorInfo | null = null

  // connection
  private ws: WebSocketLike | null = null
  private generation = 0
  private started = false
  private stopped = false
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  private typingTimer: ReturnType<typeof setTimeout> | null = null
  private receiptTimer: ReturnType<typeof setTimeout> | null = null
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private notifyScheduled = false
  private environmentCleanup: (() => void) | null = null

  // work in progress
  private readonly pending = new Map<string, Pending>()
  private readonly failed = new Map<string, Pending>()
  private readonly waiters = new Map<string, Waiter>()
  private screenOpen = false
  private deliveredUpTo = 0
  private readUpTo = 0
  private lastTypingSent = 0

  // snapshot cache (a new object whenever anything changed, so frameworks can compare by identity)
  private version = 0
  private cached: { version: number; snapshot: ChatSnapshot } | null = null
  private readonly subscribers = new Set<() => void>()

  constructor(opts: ClientOptions) {
    this.opts = opts
    this.store = opts.store ?? memoryStore()
    this.backoff = { ...DEFAULT_BACKOFF, ...opts.backoff }
    this.now = opts.now ?? Date.now
  }

  // ----------------------------------------------------------
  // Public API
  // ----------------------------------------------------------

  /** Load what is kept on the device, show it, and connect. Safe to call again after `stop()`. */
  async start(): Promise<void> {
    if (this.started && !this.stopped) return
    this.started = true
    this.stopped = false
    if (this.messages.length === 0) await this.restore()
    this.listenToEnvironment()
    this.attempt = 0
    void this.connect()
  }

  /** Close the connection and stop reconnecting. What was received stays on the device and in `getSnapshot()`. */
  stop(): void {
    this.stopped = true
    this.generation++
    this.clearTimers()
    this.environmentCleanup?.()
    this.environmentCleanup = null
    this.closeSocket(1000, 'stopped')
    this.rejectWaiters(new ChatError('stopped', 'The chat was stopped'))
    this.setState('stopped')
    void this.persistNow()
  }

  /**
   * Connect now instead of at the next scheduled attempt. Call it when the app returns to the foreground or the network
   * comes back (the library does so itself when the page reports those events). On a live connection it checks that the
   * connection is still alive.
   */
  reconnectNow(): void {
    if (this.stopped || !this.started) return
    if (this.state === 'online') {
      this.probe(5000)
      return
    }
    if (this.state === 'connecting') return
    this.clearTimer('reconnect')
    this.attempt = 0
    void this.connect()
  }

  /** Everything a screen needs, as one object; a new object whenever anything changes. */
  getSnapshot(): ChatSnapshot {
    if (this.cached && this.cached.version === this.version) return this.cached.snapshot
    const snapshot: ChatSnapshot = {
      state: this.state,
      nextAttemptAt: this.nextAttemptAt,
      messages: this.messages.slice(),
      supportTyping: this.supportTyping,
      loaded: this.loaded,
      limits: this.limits,
      conversationId: this.conversationId,
      lastSeq: this.lastSeq,
      lastError: this.lastError,
    }
    this.cached = { version: this.version, snapshot }
    return snapshot
  }

  /** Be told when the snapshot changes (also the shape React's `useSyncExternalStore` wants). Returns the way to stop. */
  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }

  on<E extends keyof ClientEvents>(event: E, fn: (payload: ClientEvents[E]) => void): () => void {
    return this.emitter.on(event, fn)
  }

  /**
   * Send a text message. Resolves with the stored message once the gateway has it (the message is already in the list,
   * as `sending`, before that). Rejects if the message is refused; while offline it waits for the connection.
   */
  sendText(text: string, opts: { replyTo?: string | ChatMessage } = {}): Promise<ChatMessage> {
    const body = text.trim()
    const max = this.limits?.textMax ?? 4000
    if (!body) return Promise.reject(new ChatError('bad_request', 'A message needs text'))
    if (body.length > max) return Promise.reject(new ChatError('message_too_long', `A message may be at most ${max} characters`))
    return this.enqueue({ kind: 'text', text: body, file: null, replyTo: opts.replyTo })
  }

  /**
   * Send a photo, video, voice note or document. The message appears at once with a local preview; the file is uploaded
   * over HTTPS and then the message is sent. `durationSeconds` is the length of a voice note.
   */
  sendFile(
    file: { blob: Blob; name?: string | null; type?: string },
    opts: { caption?: string; replyTo?: string | ChatMessage; durationSeconds?: number } = {},
  ): Promise<ChatMessage> {
    const mimeType = baseMime(file.type || file.blob.type || '')
    const kind = kindOfMime(mimeType)
    if (!kind) return Promise.reject(new ChatError('file_type_not_allowed', `Files of type ${mimeType || 'unknown'} cannot be sent`))
    const sizeBytes = file.blob.size
    const maxBytes = this.limits?.fileMaxBytes ?? DEFAULT_FILE_MAX_BYTES
    if (sizeBytes <= 0) return Promise.reject(new ChatError('bad_request', 'The file is empty'))
    if (sizeBytes > maxBytes) return Promise.reject(new ChatError('file_too_large', `A file may be at most ${Math.floor(maxBytes / 1024 / 1024)} MB`))
    if (kind === 'audio' && opts.durationSeconds !== undefined && opts.durationSeconds > MAX_VOICE_SECONDS) {
      return Promise.reject(new ChatError('file_too_large', `A voice note may be at most ${MAX_VOICE_SECONDS / 60} minutes`))
    }
    const caption = opts.caption?.trim() || null
    const captionMax = this.limits?.captionMax ?? 1024
    if (caption && caption.length > captionMax) return Promise.reject(new ChatError('message_too_long', `A caption may be at most ${captionMax} characters`))
    return this.enqueue({
      kind,
      text: caption,
      replyTo: opts.replyTo,
      file: {
        blob: file.blob,
        fileName: file.name ?? null,
        mimeType,
        sizeBytes,
        durationSeconds: opts.durationSeconds !== undefined ? Math.round(opts.durationSeconds) : null,
        fileId: null,
        attempts: 0,
        running: false,
      },
    })
  }

  /** Try a failed message again. */
  retry(id: string): Promise<ChatMessage> {
    const p = this.failed.get(id)
    const m = this.byId.get(id)
    if (!p || !m) return Promise.reject(new ChatError('not_found', 'There is no failed message with that id'))
    this.failed.delete(id)
    if (p.file) p.file.attempts = 0
    m.status = 'sending'
    m.error = null
    this.touch(m, 'updated')
    return new Promise<ChatMessage>((resolve, reject) => {
      p.resolve = resolve
      p.reject = reject
      this.pending.set(id, p)
      this.flush()
      this.persistSoon()
    })
  }

  /** Remove a failed message from the list. */
  discard(id: string): void {
    const m = this.byId.get(id)
    if (!m || m.status !== 'failed') return
    this.failed.delete(id)
    this.removeMessage(m)
    this.changed()
    this.persistSoon()
  }

  /** The chat screen is open or not. While it is open, support's messages are reported as read. */
  setScreenOpen(open: boolean): void {
    if (this.screenOpen === open) return
    this.screenOpen = open
    if (open) this.sendReceipts()
  }

  /** The user is typing. Call it on every keystroke: it sends at most every 2.5 seconds. */
  typing(): void {
    if (this.state !== 'online') return
    const t = this.now()
    if (t - this.lastTypingSent < TYPING_SEND_INTERVAL_MS) return
    this.lastTypingSent = t
    this.sendFrame({ type: 'typing' })
  }

  /**
   * An address that shows or plays the message's file. Returns the one the message has when it is good for another
   * minute, otherwise asks the gateway for a new one (which needs a connection).
   */
  async getMediaUrl(id: string): Promise<string> {
    const m = this.byId.get(id)
    const media = m?.media
    if (!m || !media) throw new ChatError('not_found', 'That message has no file')
    const fresh = media.url && (media.expiresAt === null || media.expiresAt - this.now() > LINK_REFRESH_MARGIN_MS)
    if (fresh) return media.url!
    if (!media.fileId) throw new ChatError('not_ready', 'The file is still being uploaded')
    const frame = await this.request(`url:${media.fileId}`, { type: 'file_url', file_id: media.fileId })
    const url = str(frame.url)
    if (!url) throw new ChatError('bad_response', 'The gateway sent no address')
    media.url = url
    media.expiresAt = Date.parse(str(frame.expires_at) ?? '') || null
    this.touch(m, 'updated')
    this.persistSoon()
    return url
  }

  /** Forget everything kept on this device (sign-out). */
  async clearLocal(): Promise<void> {
    this.messages = []
    this.byId.clear()
    this.byServerId.clear()
    this.lastSeq = 0
    this.conversationId = null
    this.loaded = false
    this.deliveredUpTo = 0
    this.readUpTo = 0
    await this.store.clear()
    this.changed()
  }

  // ----------------------------------------------------------
  // Sending
  // ----------------------------------------------------------

  private enqueue(input: { kind: MessageKind; text: string | null; file: FileTask | null; replyTo?: string | ChatMessage }): Promise<ChatMessage> {
    if (this.stopped && this.started) return Promise.reject(new ChatError('stopped', 'The chat was stopped'))
    if (this.pending.size >= MAX_QUEUED) return Promise.reject(new ChatError('queue_full', 'Too many messages are waiting to be sent'))
    const replyToServerId = typeof input.replyTo === 'string' ? input.replyTo : (input.replyTo?.serverId ?? null)
    const quote = replyToServerId ? this.quoteOf(replyToServerId) : null
    const id = randomId()
    const message: ChatMessage = {
      id,
      serverId: null,
      seq: null,
      mine: true,
      kind: input.kind,
      text: input.text,
      media: input.file
        ? {
            fileId: null,
            url: localPreview(input.file.blob),
            expiresAt: null,
            mimeType: input.file.mimeType,
            fileName: input.file.fileName,
            sizeBytes: input.file.sizeBytes,
            durationSeconds: input.file.durationSeconds,
          }
        : null,
      replyTo: quote,
      sender: null,
      sentAt: this.now(),
      status: 'sending',
      error: null,
    }
    this.addMessage(message)
    this.touch(message, 'added')
    return new Promise<ChatMessage>((resolve, reject) => {
      this.pending.set(id, { id, kind: input.kind, text: input.text, replyToServerId, file: input.file, inflight: false, rateTimer: null, resolve, reject })
      this.flush()
      this.persistSoon()
    })
  }

  /** Send everything that is waiting, in order. Called when something is queued and when a connection is made. */
  private flush(): void {
    if (this.state !== 'online') return
    for (const p of this.pending.values()) {
      if (p.inflight || p.rateTimer) continue
      if (p.file && !p.file.fileId) {
        void this.runUpload(p)
        continue
      }
      this.sendMessageFrame(p)
    }
  }

  private sendMessageFrame(p: Pending): void {
    p.inflight = true
    this.sendFrame({
      type: 'send',
      client_id: p.id,
      kind: p.kind,
      ...(p.text ? { text: p.text } : {}),
      ...(p.file?.fileId ? { media: { file_id: p.file.fileId } } : {}),
      ...(p.replyToServerId ? { reply_to: p.replyToServerId } : {}),
    })
  }

  /** Ask for a slot, PUT the bytes, then send the message that names the file. */
  private async runUpload(p: Pending): Promise<void> {
    const file = p.file
    if (!file || file.running) return
    file.running = true
    const gen = this.generation
    try {
      const requestId = `r-${randomId()}`
      const slot = await this.request(`up:${requestId}`, {
        type: 'upload_request',
        request_id: requestId,
        kind: p.kind,
        ...(file.fileName ? { file_name: file.fileName } : {}),
        mime_type: file.mimeType,
        size_bytes: file.sizeBytes,
        ...(file.durationSeconds ? { duration_seconds: file.durationSeconds } : {}),
      })
      const url = str(slot.upload_url)
      const fileId = str(slot.file_id)
      if (!url || !fileId) throw new ChatError('bad_response', 'The gateway sent no upload address')
      const doFetch = this.opts.fetch ?? globalThis.fetch.bind(globalThis)
      let res: Response
      try {
        res = await doFetch(url, { method: 'PUT', headers: { 'content-type': file.mimeType }, body: file.blob })
      } catch {
        throw new ChatError('upload_failed', 'The file could not be uploaded: check the connection')
      }
      if (!res.ok) {
        const body = asRecord(await res.json().catch(() => null))
        const err = asRecord(body?.error)
        const code = str(err?.code) ?? 'upload_failed'
        // An expired address is asked for again; a refusal of the file itself is final.
        throw new ChatError(code, str(err?.message) ?? `The upload was refused (${res.status})`)
      }
      file.fileId = fileId
      const m = this.byId.get(p.id)
      if (m?.media) {
        m.media.fileId = fileId
        this.touch(m, 'updated')
      }
      if (gen === this.generation && this.state === 'online') this.sendMessageFrame(p)
      // else: the connection dropped meanwhile; the next flush sends the message
    } catch (err) {
      const e = err instanceof ChatError ? err : new ChatError('upload_failed', 'The file could not be sent')
      const transient = e.code === 'offline' || e.code === 'upload_failed' || e.code === 'expired' || e.code === 'timeout'
      file.attempts++
      if (transient && file.attempts < MAX_UPLOAD_ATTEMPTS) {
        // The next connection (or the next flush) tries again.
        if (this.state === 'online' && e.code !== 'offline') setTimeout(() => this.flush(), 1000 * file.attempts)
      } else {
        this.failMessage(p, e)
      }
    } finally {
      file.running = false
    }
  }

  private failMessage(p: Pending, err: ChatError): void {
    this.pending.delete(p.id)
    if (p.rateTimer) clearTimeout(p.rateTimer)
    p.rateTimer = null
    p.inflight = false
    this.failed.set(p.id, p)
    const m = this.byId.get(p.id)
    if (m) {
      m.status = 'failed'
      m.error = { code: err.code, message: err.message }
      this.touch(m, 'updated')
    }
    p.reject(err)
    this.persistSoon()
  }

  // ----------------------------------------------------------
  // Connecting
  // ----------------------------------------------------------

  private async connect(): Promise<void> {
    if (this.stopped) return
    const gen = ++this.generation
    this.clearTimer('reconnect')
    this.nextAttemptAt = null
    this.setState('connecting')

    let session: Session
    try {
      session = await this.opts.getSession()
    } catch (err) {
      if (gen !== this.generation || this.stopped) return
      this.noteError({ code: 'session_failed', message: err instanceof Error ? err.message : 'Could not get a chat session' })
      this.scheduleReconnect()
      return
    }
    if (gen !== this.generation || this.stopped) return

    const url = this.socketUrl(session)
    if (!url) {
      this.noteError({ code: 'bad_session', message: 'The session has neither a url nor a wsPath with a baseUrl' })
      this.scheduleReconnect()
      return
    }
    const WS = this.opts.WebSocket ?? (globalThis as { WebSocket?: new (u: string) => WebSocketLike }).WebSocket
    if (!WS) {
      this.noteError({ code: 'no_websocket', message: 'This platform has no WebSocket' })
      this.setState('stopped')
      return
    }

    let ws: WebSocketLike
    try {
      ws = new WS(url)
    } catch (err) {
      this.noteError({ code: 'connect_failed', message: err instanceof Error ? err.message : 'Could not open the connection' })
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    this.connectTimer = setTimeout(() => {
      if (gen === this.generation && this.state === 'connecting') this.dropConnection(gen, 'no welcome in time')
    }, CONNECT_TIMEOUT_MS)

    ws.onopen = () => {
      if (gen !== this.generation) return
      this.rawSend({ type: 'hello', v: 1, token: session.token, device_id: this.opts.deviceId, ...(this.opts.appVersion ? { app_version: this.opts.appVersion } : {}), last_seq: this.lastSeq })
    }
    ws.onmessage = (ev) => {
      if (gen !== this.generation) return
      const frame = typeof ev.data === 'string' ? safeParse(ev.data) : null
      if (!frame) return
      this.emitter.emit('wire', { direction: 'in', frame })
      this.handleFrame(frame, gen)
    }
    ws.onclose = (ev) => this.onSocketClosed(gen, ev.code, ev.reason)
    ws.onerror = () => {
      /* a close event follows */
    }
  }

  private socketUrl(session: Session): string | null {
    if (session.url) return session.url
    if (session.wsPath && this.opts.baseUrl) return this.opts.baseUrl.replace(/^http/i, 'ws').replace(/\/+$/, '') + session.wsPath
    return null
  }

  private onSocketClosed(gen: number, code: number, reason: string): void {
    if (gen !== this.generation) return
    this.clearConnectionTimers()
    this.ws = null
    this.generation++ // anything still arriving from this socket is ignored
    for (const p of this.pending.values()) p.inflight = false
    this.rejectWaiters(new ChatError('offline', 'The connection closed'))
    this.setSupportTyping(false)
    if (this.stopped) return
    if (code === 4409) {
      // Another connection of this same device took over: reconnecting would only start a fight.
      this.noteError({ code: 'replaced', message: 'Another connection of this device took over' })
      this.setState('replaced')
      return
    }
    if (code === 4401) this.noteError({ code: 'unauthorized', message: 'The chat session was refused: asking for a new one' })
    else if (code !== 1000 && code !== 1012) this.noteError({ code: 'connection_lost', message: reason || `The connection closed (${code})` })
    // A restart of the gateway (1012) is expected: come straight back.
    if (code === 1012) this.attempt = 0
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    const wait = backoffDelay(this.attempt++, this.backoff)
    this.nextAttemptAt = this.now() + wait
    this.setState('offline')
    this.clearTimer('reconnect')
    this.reconnectTimer = setTimeout(() => void this.connect(), wait)
  }

  /** Close a connection that is not answering and carry on as if it had closed. */
  private dropConnection(gen: number, reason: string): void {
    if (gen !== this.generation) return
    const ws = this.ws
    try {
      ws?.close(4000, reason)
    } catch {
      /* already gone */
    }
    // A dead connection may never report its own close: do not wait for it.
    setTimeout(() => this.onSocketClosed(gen, 4000, reason), 1500)
  }

  private closeSocket(code: number, reason: string): void {
    const ws = this.ws
    this.ws = null
    try {
      if (ws) {
        ws.onclose = null
        ws.onmessage = null
        ws.close(code, reason)
      }
    } catch {
      /* already closed */
    }
  }

  // ----------------------------------------------------------
  // Frames from the gateway
  // ----------------------------------------------------------

  private handleFrame(f: Record<string, unknown>, gen: number): void {
    switch (f.type) {
      case 'welcome':
        return this.onWelcome(f, gen)
      case 'deliver':
        return this.onDeliver(f)
      case 'ack':
        return this.onAck(f)
      case 'receipt':
        return this.onSupportReceipt(f)
      case 'typing':
        return this.onSupportTyping()
      case 'upload_slot': {
        const key = `up:${str(f.request_id)}`
        return this.settle(key, f)
      }
      case 'file_url':
        return this.settle(`url:${str(f.file_id)}`, f)
      case 'resume_done':
        if (f.more === true) this.sendFrame({ type: 'resume', last_seq: this.lastSeq })
        else if (!this.loaded) {
          this.loaded = true
          this.changed()
          this.emitter.emit('loaded', undefined)
        }
        return
      case 'pong':
        this.clearTimer('pong')
        return
      case 'error':
        return this.onError(f)
    }
  }

  private onWelcome(f: Record<string, unknown>, gen: number): void {
    this.clearTimer('connect')
    const lim = asRecord(f.limits)
    if (lim) {
      this.limits = {
        textMax: num(lim.text_max) ?? 4000,
        captionMax: num(lim.caption_max) ?? 1024,
        fileMaxBytes: num(lim.file_max_bytes) ?? DEFAULT_FILE_MAX_BYTES,
        sendPerWindow: num(lim.send_per_window) ?? 30,
        sendWindowSeconds: num(lim.send_window_s) ?? 10,
      }
    }
    const conv = asRecord(f.conversation)
    const convId = str(conv?.id)
    const serverLast = num(conv?.last_seq)
    // The conversation on the gateway is not the one kept here (another user signed in, or the gateway lost history): start again.
    if ((this.conversationId && convId && convId !== this.conversationId) || (serverLast !== null && serverLast < this.lastSeq)) {
      this.resetConversation()
      this.sendFrame({ type: 'resume', last_seq: 0 })
    }
    this.conversationId = convId ?? this.conversationId
    this.attempt = 0
    this.lastError = null
    this.setState('online')

    const hb = (num(f.heartbeat_s) ?? 25) * 1000
    this.clearTimer('ping')
    this.pingTimer = setInterval(() => this.probe(this.opts.pongTimeoutMs ?? 10_000), hb)
    // Everything that was waiting goes out now, in order; unacknowledged sends are repeated with the same ids.
    this.flush()
    if (this.screenOpen || this.opts.autoAcknowledge !== false) this.sendReceipts()
    void gen
  }

  private resetConversation(): void {
    this.messages = this.messages.filter((m) => m.status === 'sending' || m.status === 'failed')
    this.byServerId.clear()
    this.byId.clear()
    for (const m of this.messages) this.byId.set(m.id, m)
    this.lastSeq = 0
    this.deliveredUpTo = 0
    this.readUpTo = 0
    this.loaded = false
    this.changed()
  }

  private onDeliver(f: Record<string, unknown>): void {
    const serverId = str(f.server_id)
    const seq = num(f.seq)
    if (!serverId || seq === null) return
    if (seq > this.lastSeq) this.lastSeq = seq
    const mine = f.direction === 'in'
    const wire = str(f.status) as MessageStatus | null
    const existing = this.byServerId.get(serverId)
    if (existing) {
      // Already shown (a replay, or the acknowledgement came first): only move it forward, and refresh its file link.
      if (mine && wire && forward(existing.status, wire)) existing.status = wire
      const media = this.mediaFrom(f.media)
      if (media && existing.media) {
        existing.media.url = media.url
        existing.media.expiresAt = media.expiresAt
      }
      this.touch(existing, 'updated')
      return
    }
    const message: ChatMessage = {
      id: serverId,
      serverId,
      seq,
      mine,
      kind: (str(f.kind) as MessageKind) ?? 'text',
      text: str(f.text),
      media: this.mediaFrom(f.media),
      replyTo: this.quoteFrom(f.reply_to),
      sender: str(asRecord(f.sender)?.name),
      sentAt: Date.parse(str(f.sent_at) ?? '') || this.now(),
      status: mine && wire && STATUS_ORDER.includes(wire) ? wire : 'sent',
      error: null,
    }
    this.addMessage(message)
    this.touch(message, 'added')
    if (!mine) {
      // The answer has arrived: the typing line goes.
      this.setSupportTyping(false)
      this.scheduleReceipts()
    }
    this.persistSoon()
  }

  private onAck(f: Record<string, unknown>): void {
    const clientId = str(f.client_id)
    const serverId = str(f.server_id)
    const seq = num(f.seq)
    if (!clientId || !serverId || seq === null) return
    if (seq > this.lastSeq) this.lastSeq = seq
    const p = this.pending.get(clientId)
    const mine = this.byId.get(clientId)
    if (!mine) return
    if (p) {
      this.pending.delete(clientId)
      if (p.rateTimer) clearTimeout(p.rateTimer)
    }
    const already = this.byServerId.get(serverId)
    if (already && already !== mine) {
      // The same message came back as a replay before its acknowledgement: keep one.
      if (mine.status === 'sending') this.removeMessage(mine)
      p?.resolve(already)
      this.changed()
      return
    }
    mine.serverId = serverId
    mine.seq = seq
    if (mine.status === 'sending' || mine.status === 'failed') mine.status = 'sent'
    mine.error = null
    this.byServerId.set(serverId, mine)
    this.sortMessages()
    this.touch(mine, 'updated')
    p?.resolve(mine)
    this.persistSoon()
  }

  /** Support's side of my own messages: Halo received them (delivered) or an agent read them (read). */
  private onSupportReceipt(f: Record<string, unknown>): void {
    const status = str(f.status) as MessageStatus | null
    if (status !== 'delivered' && status !== 'read') return
    const list = Array.isArray(f.messages) ? f.messages : []
    for (const r of list) {
      const id = str(asRecord(r)?.server_id)
      const m = id ? this.byServerId.get(id) : undefined
      if (m && m.mine && forward(m.status, status)) {
        m.status = status
        this.touch(m, 'updated')
      }
    }
    this.persistSoon()
  }

  private onSupportTyping(): void {
    this.setSupportTyping(true)
    if (this.typingTimer) clearTimeout(this.typingTimer)
    this.typingTimer = setTimeout(() => this.setSupportTyping(false), TYPING_SHOWN_MS)
  }

  private onError(f: Record<string, unknown>): void {
    const code = str(f.code) ?? 'error'
    const message = str(f.message) ?? 'The gateway refused the request'
    const clientId = str(f.client_id)
    const requestId = str(f.request_id)
    const err = new ChatError(code, message)

    if (requestId && this.rejectWaiter(`up:${requestId}`, err)) return
    if (code === 'file_not_found' && !clientId) {
      for (const key of [...this.waiters.keys()]) if (key.startsWith('url:')) this.rejectWaiter(key, err)
      return
    }
    if (clientId) {
      const p = this.pending.get(clientId)
      if (p && code === 'rate_limited') {
        // Too fast: the message stays queued and goes again after the wait the gateway named.
        p.inflight = false
        const wait = Math.max(1, num(f.retry_after) ?? 1) * 1000
        p.rateTimer = setTimeout(() => {
          p.rateTimer = null
          this.flush()
        }, wait)
        return
      }
      if (p) {
        this.failMessage(p, err)
        return
      }
    }
    this.noteError({ code, message })
  }

  // ----------------------------------------------------------
  // Receipts, typing, liveness
  // ----------------------------------------------------------

  private scheduleReceipts(): void {
    if (this.receiptTimer) return
    this.receiptTimer = setTimeout(() => {
      this.receiptTimer = null
      this.sendReceipts()
    }, RECEIPT_DEBOUNCE_MS)
  }

  /** Tell the gateway what the app has: "delivered" for everything from support, "read" too while the chat screen is open. */
  private sendReceipts(): void {
    if (this.state !== 'online') return
    let top = 0
    for (const m of this.messages) if (!m.mine && m.seq !== null && m.seq > top) top = m.seq
    if (top === 0) return
    if (this.opts.autoAcknowledge !== false && top > this.deliveredUpTo) {
      this.deliveredUpTo = top
      this.sendFrame({ type: 'receipt', up_to_seq: top, status: 'delivered' })
    }
    if (this.screenOpen && top > this.readUpTo) {
      this.readUpTo = top
      this.sendFrame({ type: 'receipt', up_to_seq: top, status: 'read' })
    }
  }

  /** Is the connection alive? A ping that gets no pong in time closes it and reconnects. */
  private probe(timeoutMs: number): void {
    if (this.state !== 'online') return
    const gen = this.generation
    this.rawSend({ type: 'ping', t: this.now() })
    this.clearTimer('pong')
    this.pongTimer = setTimeout(() => this.dropConnection(gen, 'no pong'), timeoutMs)
  }

  private setSupportTyping(on: boolean): void {
    if (this.supportTyping === on) return
    this.supportTyping = on
    if (!on && this.typingTimer) {
      clearTimeout(this.typingTimer)
      this.typingTimer = null
    }
    this.emitter.emit('typing', on)
    this.changed()
  }

  // ----------------------------------------------------------
  // Requests that wait for an answer (upload slot, file link)
  // ----------------------------------------------------------

  private request(key: string, frame: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.state !== 'online') return Promise.reject(new ChatError('offline', 'The chat is not connected'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(key)
        reject(new ChatError('timeout', 'The gateway did not answer'))
      }, this.opts.requestTimeoutMs ?? 10_000)
      this.waiters.set(key, { resolve, reject, timer })
      this.sendFrame(frame)
    })
  }

  private settle(key: string, frame: Record<string, unknown>): void {
    const w = this.waiters.get(key)
    if (!w) return
    clearTimeout(w.timer)
    this.waiters.delete(key)
    w.resolve(frame)
  }

  private rejectWaiter(key: string, err: ChatError): boolean {
    const w = this.waiters.get(key)
    if (!w) return false
    clearTimeout(w.timer)
    this.waiters.delete(key)
    w.reject(err)
    return true
  }

  private rejectWaiters(err: ChatError): void {
    for (const key of [...this.waiters.keys()]) this.rejectWaiter(key, err)
  }

  // ----------------------------------------------------------
  // Frames to the gateway
  // ----------------------------------------------------------

  /** Send a frame, unless the test interceptor swallows or delays it. */
  private sendFrame(frame: Record<string, unknown>): void {
    const verdict = this.opts.interceptSend?.(frame) ?? 'send'
    if (verdict === 'drop') return
    if (typeof verdict === 'number' && verdict > 0) {
      const gen = this.generation
      setTimeout(() => {
        if (gen === this.generation) this.rawSend(frame)
      }, verdict)
      return
    }
    this.rawSend(frame)
  }

  private rawSend(frame: Record<string, unknown>): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WS_OPEN) return
    try {
      ws.send(JSON.stringify(frame))
      this.emitter.emit('wire', { direction: 'out', frame })
    } catch {
      /* the close event follows */
    }
  }

  // ----------------------------------------------------------
  // The message list
  // ----------------------------------------------------------

  private addMessage(m: ChatMessage): void {
    this.messages.push(m)
    this.byId.set(m.id, m)
    if (m.serverId) this.byServerId.set(m.serverId, m)
    this.sortMessages()
  }

  private removeMessage(m: ChatMessage): void {
    this.messages = this.messages.filter((x) => x !== m)
    this.byId.delete(m.id)
    if (m.serverId && this.byServerId.get(m.serverId) === m) this.byServerId.delete(m.serverId)
  }

  /** By sequence number; a message not stored yet goes after the ones that are, in the order it was written. */
  private sortMessages(): void {
    const index = new Map(this.messages.map((m, i) => [m, i] as const))
    this.messages.sort((a, b) => {
      if (a.seq !== null && b.seq !== null) return a.seq - b.seq
      if (a.seq !== null) return -1
      if (b.seq !== null) return 1
      return (index.get(a) ?? 0) - (index.get(b) ?? 0)
    })
  }

  private quoteOf(serverId: string): Quote | null {
    const m = this.byServerId.get(serverId)
    if (!m) return null
    return { serverId, kind: m.kind, text: m.text ? m.text.slice(0, 140) : null, from: m.mine ? 'you' : 'support' }
  }

  private quoteFrom(v: unknown): Quote | null {
    const q = asRecord(v)
    const serverId = str(q?.server_id)
    if (!q || !serverId) return null
    return { serverId, kind: (str(q.kind) as MessageKind) ?? 'text', text: str(q.text), from: q.from === 'you' ? 'you' : 'support' }
  }

  private mediaFrom(v: unknown): ChatMedia | null {
    const m = asRecord(v)
    if (!m) return null
    return {
      fileId: str(m.file_id),
      url: str(m.url),
      expiresAt: Date.parse(str(m.expires_at) ?? '') || null,
      mimeType: str(m.mime_type) ?? 'application/octet-stream',
      fileName: str(m.file_name),
      sizeBytes: num(m.size_bytes) ?? 0,
      durationSeconds: num(m.duration_seconds),
    }
  }

  // ----------------------------------------------------------
  // Keeping things on the device
  // ----------------------------------------------------------

  private async restore(): Promise<void> {
    let saved: StoredState | null = null
    try {
      saved = await this.store.load()
    } catch {
      saved = null
    }
    if (!saved || saved.v !== 1) return
    this.conversationId = saved.conversationId
    this.lastSeq = saved.lastSeq
    for (const m of saved.messages) {
      this.messages.push(m)
      this.byId.set(m.id, m)
      if (m.serverId) this.byServerId.set(m.serverId, m)
    }
    // Messages written but never stored by the gateway are sent again, with the same ids.
    for (const p of saved.pending) {
      const quote = p.replyToServerId ? this.quoteOf(p.replyToServerId) : null
      const m: ChatMessage = { id: p.id, serverId: null, seq: null, mine: true, kind: 'text', text: p.text, media: null, replyTo: quote, sender: null, sentAt: p.sentAt, status: 'sending', error: null }
      this.messages.push(m)
      this.byId.set(m.id, m)
      const entry: Pending = { id: p.id, kind: 'text', text: p.text, replyToServerId: p.replyToServerId, file: null, inflight: false, rateTimer: null, resolve: () => undefined, reject: () => undefined }
      this.pending.set(p.id, entry)
    }
    this.sortMessages()
    this.loaded = saved.messages.length > 0
    this.changed()
  }

  private persistSoon(): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.persistNow()
    }, PERSIST_DEBOUNCE_MS)
  }

  private async persistNow(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    const stored = this.messages
      .filter((m) => m.seq !== null && (m.status !== 'sending' && m.status !== 'failed'))
      .slice(-KEEP_MESSAGES)
      .map((m) => ({ ...m, media: m.media ? { ...m.media, url: m.media.url && m.media.url.startsWith('blob:') ? null : m.media.url } : null }))
    const pending = [...this.pending.values()]
      .filter((p) => !p.file && p.text)
      .map((p) => ({ id: p.id, text: p.text!, replyToServerId: p.replyToServerId, sentAt: this.byId.get(p.id)?.sentAt ?? this.now() }))
    try {
      await this.store.save({ v: 1, conversationId: this.conversationId, lastSeq: this.lastSeq, messages: stored, pending })
    } catch {
      /* the chat works without the store */
    }
  }

  // ----------------------------------------------------------
  // Notifying the screen
  // ----------------------------------------------------------

  private touch(m: ChatMessage, change: 'added' | 'updated'): void {
    this.emitter.emit('message', { message: m, change })
    this.changed()
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return
    this.state = next
    this.emitter.emit('state', next)
    this.changed()
  }

  private noteError(e: ChatErrorInfo): void {
    this.lastError = e
    this.emitter.emit('error', e)
    this.changed()
  }

  /** A new snapshot is due; subscribers hear about it once per turn of the event loop, however many changes there were. */
  private changed(): void {
    this.version++
    if (this.notifyScheduled) return
    this.notifyScheduled = true
    queueMicrotask(() => {
      this.notifyScheduled = false
      for (const fn of [...this.subscribers]) {
        try {
          fn()
        } catch (err) {
          if (typeof console !== 'undefined') console.error('[vircle-chat] a subscriber failed:', err)
        }
      }
    })
  }

  // ----------------------------------------------------------
  // Timers and the environment
  // ----------------------------------------------------------

  private clearTimer(which: 'reconnect' | 'connect' | 'ping' | 'pong'): void {
    if (which === 'reconnect' && this.reconnectTimer) clearTimeout(this.reconnectTimer), (this.reconnectTimer = null)
    if (which === 'connect' && this.connectTimer) clearTimeout(this.connectTimer), (this.connectTimer = null)
    if (which === 'ping' && this.pingTimer) clearInterval(this.pingTimer), (this.pingTimer = null)
    if (which === 'pong' && this.pongTimer) clearTimeout(this.pongTimer), (this.pongTimer = null)
  }

  private clearConnectionTimers(): void {
    this.clearTimer('connect')
    this.clearTimer('ping')
    this.clearTimer('pong')
  }

  private clearTimers(): void {
    this.clearTimer('reconnect')
    this.clearConnectionTimers()
    for (const t of [this.typingTimer, this.receiptTimer, this.persistTimer]) if (t) clearTimeout(t)
    this.typingTimer = this.receiptTimer = this.persistTimer = null
    for (const p of this.pending.values()) if (p.rateTimer) clearTimeout(p.rateTimer)
  }

  /** Reconnect when the network comes back or the app returns to the foreground. */
  private listenToEnvironment(): void {
    if (this.opts.listenToEnvironment === false || this.environmentCleanup) return
    const g = globalThis as { addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void; document?: { addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void; visibilityState?: string } }
    const online = () => this.reconnectNow()
    const visible = () => {
      if (g.document?.visibilityState === 'visible') this.reconnectNow()
    }
    g.addEventListener?.('online', online)
    g.document?.addEventListener?.('visibilitychange', visible)
    // Cordova and Capacitor fire "resume" on the document when the app comes back.
    g.document?.addEventListener?.('resume', online)
    this.environmentCleanup = () => {
      g.removeEventListener?.('online', online)
      g.document?.removeEventListener?.('visibilitychange', visible)
      g.document?.removeEventListener?.('resume', online)
    }
  }
}

/** Is `next` a step forward from `current`? A status never goes back. */
function forward(current: MessageStatus, next: MessageStatus): boolean {
  return STATUS_ORDER.indexOf(next) > STATUS_ORDER.indexOf(current)
}

function safeParse(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text))
  } catch {
    return null
  }
}

/** A local address for showing a file before it is uploaded, where the platform can make one. */
function localPreview(blob: Blob): string | null {
  try {
    const u = (globalThis as { URL?: { createObjectURL?: (b: Blob) => string } }).URL
    return u?.createObjectURL ? u.createObjectURL(blob) : null
  } catch {
    return null
  }
}
