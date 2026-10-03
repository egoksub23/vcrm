// ============================================================
// What the app sees. The frames on the wire are documented in docs/vircle-chat-app-protocol.md; this library
// turns them into a list of messages with a status, and a connection state.
// ============================================================

export type MessageKind = 'text' | 'image' | 'video' | 'audio' | 'document'

/**
 * The state of one message.
 *   sending    not stored by the gateway yet (offline, uploading, or waiting for the acknowledgement)
 *   sent       stored by the gateway (one tick). Also the state of a message from support that has arrived.
 *   delivered  support has received it (two ticks)
 *   read       an agent has read it (two blue ticks)
 *   failed     it could not be sent; `error` says why and `retry(id)` tries again
 */
export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed'

export interface ChatMedia {
  /** The gateway's id for the file (undefined while it is still being uploaded). */
  fileId: string | null
  /** Where to show or play the file from. For a file being sent this is a local preview until it is uploaded. */
  url: string | null
  /** When `url` stops working (milliseconds since the epoch), or null for a local preview. */
  expiresAt: number | null
  mimeType: string
  fileName: string | null
  sizeBytes: number
  /** Length of a voice note, in seconds. */
  durationSeconds: number | null
}

/** The message another one quotes (a snapshot: it stays readable even if the original scrolled away). */
export interface Quote {
  serverId: string
  kind: MessageKind
  text: string | null
  /** `you` when the user wrote the quoted message, `support` when support did. */
  from: 'you' | 'support'
}

export interface ChatErrorInfo {
  /** A gateway code (`message_too_long`, `file_type_not_allowed`, ...) or one of ours (`offline`, `upload_failed`, `stopped`). */
  code: string
  message: string
}

export interface ChatMessage {
  /** Stable for the life of the message: use it as the list key. A message you sent keeps the id it was given before it was stored. */
  id: string
  /** The gateway's id, once the message is stored. */
  serverId: string | null
  /** The message's place in the conversation, once stored. Show messages in this order. */
  seq: number | null
  /** True for the user's own messages, false for support's. */
  mine: boolean
  kind: MessageKind
  /** The text, or the caption of a file. */
  text: string | null
  media: ChatMedia | null
  replyTo: Quote | null
  /** Who wrote it, for a message from support. */
  sender: string | null
  /** When it was sent (milliseconds since the epoch). */
  sentAt: number
  status: MessageStatus
  error: ChatErrorInfo | null
}

/**
 * idle        not started
 * connecting  opening the connection (asking for a session, then the socket)
 * online      connected and in step with the gateway
 * offline     not connected; a new attempt is scheduled (`nextAttemptAt`)
 * replaced    another connection of this same device took over; the library does not reconnect
 * stopped     `stop()` was called
 */
export type ConnectionState = 'idle' | 'connecting' | 'online' | 'offline' | 'replaced' | 'stopped'

export interface Limits {
  textMax: number
  captionMax: number
  fileMaxBytes: number
  /** Messages the gateway accepts per `sendWindowSeconds`. */
  sendPerWindow: number
  sendWindowSeconds: number
}

/** Everything a screen needs, as one immutable object that is replaced (never changed) when anything in it changes. */
export interface ChatSnapshot {
  state: ConnectionState
  /** When the next connection attempt happens (milliseconds since the epoch), while `offline`. */
  nextAttemptAt: number | null
  /** The conversation in order. */
  messages: readonly ChatMessage[]
  /** True while an agent is typing. */
  supportTyping: boolean
  /** True once the history the gateway holds has been loaded at least once on this device (or it is empty). */
  loaded: boolean
  limits: Limits | null
  conversationId: string | null
  /** The highest message number this device holds. */
  lastSeq: number
  /** The last thing that went wrong with the connection itself (not with a message), or null. */
  lastError: ChatErrorInfo | null
}

/** What the app gives the library to get into the gateway: a session from the Vircle backend. */
export interface Session {
  /** The one-time connect token from `POST /v1/sessions`. */
  token: string
  /** The full `wss://` address of the socket. Give this, or `wsPath` with `baseUrl` in the options. */
  url?: string
  /** The `ws_path` the gateway answered (`/ws`). */
  wsPath?: string
}

export type WireDirection = 'in' | 'out'

export interface ClientEvents {
  state: ConnectionState
  /** A message was added, or one of its fields (status, media link, ...) changed. */
  message: { message: ChatMessage; change: 'added' | 'updated' }
  typing: boolean
  error: ChatErrorInfo
  /** Every frame, as sent and as received: for logs and the simulator. */
  wire: { direction: WireDirection; frame: Record<string, unknown> }
  /** The first load of history finished. */
  loaded: void
}

export interface BackoffOptions {
  minMs: number
  maxMs: number
  factor: number
  /** 0 to 1: how much of the wait is randomised (0.3 means plus or minus 30%). */
  jitter: number
}

/** What to do with a frame before it is sent (a testing aid: swallow or delay a receipt, for example). */
export type SendInterceptor = (frame: Record<string, unknown>) => 'send' | 'drop' | number

export interface ClientOptions {
  /** Ask your backend for a chat session. Called before every connection attempt, because a token works once. */
  getSession: () => Promise<Session>
  /** Stable per install. Two connections with the same id replace each other. */
  deviceId: string
  appVersion?: string
  /** Used when `getSession` returns a `wsPath` instead of a full address (for example `https://chat.vircle.tech`). */
  baseUrl?: string
  /** Where messages are kept between launches. Default: in memory only. See `localStorageStore`. */
  store?: ChatStore
  backoff?: Partial<BackoffOptions>
  /** Send "delivered" for every message from support as it arrives. Default true. */
  autoAcknowledge?: boolean
  /** Reconnect when the network comes back or the app returns to the foreground. Default true when the page has those events. */
  listenToEnvironment?: boolean
  /** How long to wait for an answer to a ping before the connection is considered dead. Default 10 seconds. */
  pongTimeoutMs?: number
  /** How long to wait for an upload slot or a file link. Default 10 seconds. */
  requestTimeoutMs?: number
  /** Replace the platform's `WebSocket` (Node, tests). */
  WebSocket?: new (url: string) => WebSocketLike
  /** Replace the platform's `fetch` (Node, tests). */
  fetch?: typeof fetch
  /** See `SendInterceptor`. */
  interceptSend?: SendInterceptor
  now?: () => number
}

/** The part of the standard `WebSocket` the library uses. */
export interface WebSocketLike {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code: number; reason: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
}

/** What is kept between launches. */
export interface StoredState {
  v: 1
  conversationId: string | null
  lastSeq: number
  messages: ChatMessage[]
  /** Text messages written but not yet stored by the gateway: sent again on the next connection. */
  pending: { id: string; text: string; replyToServerId: string | null; sentAt: number }[]
}

export interface ChatStore {
  load(): Promise<StoredState | null>
  save(state: StoredState): Promise<void>
  clear(): Promise<void>
}

export class ChatError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ChatError'
  }
}
