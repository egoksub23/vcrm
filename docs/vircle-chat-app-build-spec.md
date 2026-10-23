# Vircle Chat in the Vircle app: build specification

For the engineer, and for the coding agent working under them, who builds the **chat engine and the chat screen** inside the Vircle hybrid
app (Ionic + Capacitor, three builds: Apple, Android, Huawei). Version 1.0, 21 October 2026. Written by the Halo team, who own the gateway
and the client library.

This is the **how**. `vircle-chat-app-design.docx` is the **what and why** (features, decisions, keys, push, device list, work breakdown).
Read the design document's sections 1 to 3, 5 and 7.7 first; this document does not repeat them, it turns them into buildable pieces
with acceptance criteria.

---

# 0. Read this first (rules of work)

## 0.1 What "done" means

The customer-care chat inside the Vircle app behaves like WhatsApp for the customer, talks to Vircle Halo through the Vircle Chat
gateway, and passes every acceptance criterion in section 12 and the checklist in section 14. You can verify most of it **without a
person**: section 13 gives you a local gateway and a scripted "support agent". Only the physical-device checks need a human.

## 0.2 Order of authority (when two sources disagree)

1. The library's own types and README (`library/src/types.ts`, `library/README.md`): what the library really does.
2. This specification.
3. `vircle-chat-app-design.docx`.
4. `vircle-chat-app-protocol.md` and `protocol/protocol.ts` (only if you must see what travels).

If something you need is in none of them, use section 15 (defaults); if it is not there either, **stop and ask** (section 15.2) instead of
inventing. Never guess an API: the library's surface is listed in Appendix A and nothing else exists.

## 0.3 Rules you must not break

- **No secret in the app, ever.** The only secret the chat needs (the sessions key) lives on the Vircle backend. The app only ever holds a
  one-time connect token, in memory, for about a minute.
- **Do not write your own WebSocket or HTTP code for the chat.** Use `@vircle/chat-client`. It does connecting, reconnecting, resuming,
  queueing, uploads, ticks and typing. Do not modify its source; if you find a bug, write a failing test that shows it and report it to the
  Halo team.
- **Never log** tokens, message text, phone numbers, e-mail addresses or file names. Log codes and counts only.
- **Never store a media URL.** Links expire in 24 hours. Store identifiers and files, ask the library for a link just before use.
- **Never save to the phone's gallery automatically.** Only when the person taps **Save to gallery** (owner's decision).
- **No GIF picker, no stickers, no location, no contact card, no polls, no reactions, no edit or delete, no forward, no link previews.**
  They are out of scope for version 1. Do not add them "because they are easy".
- **Never upload** HEIC/HEIF, `.gif`, WebM, MOV, SVG, ZIP or Opus/WebM audio. Convert first (section 6.6) or refuse politely.
- **Build the engine with no framework or Capacitor imports** (section 3). Everything platform-specific sits behind a port, so the engine can
  be tested in Node.
- **Smallest change that satisfies the criterion.** Do not refactor the host app, change its navigation, theme or build, except where a task
  says so.

## 0.4 How to work through this

Do the tasks in section 12 **in order**. For each: write the tests first or alongside, make the acceptance criteria pass, run the whole
test suite and the linter, then move on. A task is finished only when its acceptance criteria are all demonstrably true (a passing test, or a
screenshot attached to the commit for visual ones). Keep commits small: one task, one commit, message "chat T07: composer".

---

# 1. What you are building

## 1.1 In scope

An **engine** (framework-free TypeScript) and a **screen** (in the app's own UI framework) for one conversation per signed-in person:

text, emoji (keyboard and in-app picker), photos, videos, documents, audio files, camera capture, voice notes, captions, replies (quote),
typing indicator both ways, sent/delivered/read ticks, offline queueing, unread badge, GIF display, deep link and push-tap handling,
**older history on scroll (up to 90 days, from Halo)**, **a copy of the conversation kept on the phone until Clear chat**, **Clear chat**,
**sign-out wipe**, **a 200 MB cache of photos and voice notes**, and **Save to gallery on tap**.

## 1.2 Out of scope

The gateway, Halo, the Vircle backend's session endpoint, the push infrastructure (FCM, APNs, Huawei Push Kit), the library's internals,
anything not listed above.

## 1.3 Two phases

| Phase | What | When |
| --- | --- | --- |
| **A** | Everything except reaching to Halo. The engine keeps its own copy of every message it sees, so "kept until Clear chat" works from day one. | Start now |
| **B** | Reaching **past** the phone's own copy, to Halo, with the library's `fetchHistory` call. **Library 1.1.0, in the kit, has it**, and the simulator answers with a made-up older conversation. | Now: after Phase A, or alongside it. |

T18 is Phase A, T19 is Phase B. Do A first; B is not blocked.

---

# 2. What you have, what you lack, what to do about it

| Item | State | What to do |
| --- | --- | --- |
| Library `@vircle/chat-client` 1.1.0 (+ TypeScript source) | In the kit, `library/` | `npm install ./library/vircle-chat-client-1.1.0.tgz` |
| Simulator and scripted support agent | In the kit, `simulator/` | Section 13.1. Runs on your machine, no server, no Halo |
| Reference screens | Kit, `screens/` | Behaviour and structure only. Not the visual design |
| Emoji data (1,914 emoji with search words) | Kit, `emoji/emoji.js` | Use for the picker (T13) |
| Backend session endpoint `POST /chat/session` | **Not built** (Vircle backend developer) | In development builds only, use `DevSimulatorSessionPort` (section 13.3) which asks the local simulator for a token. It must be impossible to include in a production build (T00 criterion) |
| Sandbox Halo workspace and a real gateway token | **Do not exist yet** | Develop against the local simulator. Do not ask for production access |
| Push API payload, Huawei push registration | **Unknown** | Build the deep-link handling from `https://app.vircle.com/chat/{conversation_id}` (T16) and the alert marker `data.chat_alert === '1'` behind `PushRoutingPort` (agreed with the Halo team; the push team still has to confirm the push API passes the field through) |
| Visual design (colours, fonts, icons, both themes) | From Vircle design | Use the app's existing theme tokens; leave every colour a token, never a hard-coded value (T20) |
| Encryption-at-rest policy | Undecided (Security) | Code to `SqlPort`; encryption is a configuration of the adapter, not of the engine |
| App languages | Vircle's list | All visible words go through the app's i18n with the keys in section 10; supply English |

---

# 3. Architecture

```
  UI layer (the app's framework: Angular, React or Vue)      <- components only; no business rules
        |  uses
        v
  ChatEngine (framework-free TypeScript, no Capacitor imports)
        |  uses                      |  uses
        v                            v
  @vircle/chat-client (library)    Ports (interfaces, section 4)
                                        |  implemented by
                                        v
                          Platform adapters (the ONLY code importing @capacitor/* and plugins)
```

**Dependency rules** (enforce with a lint rule or a test that greps imports, T00):

1. `engine/` imports nothing from `@capacitor/*`, `@angular/*`, `react`, `vue`, `@ionic/*`, or the DOM-framework-specific anything. It may use
   standard web APIs that exist in current Node too (`Intl`, `URL`, `Blob`, `crypto.randomUUID`) and must reach everything else through a port.
2. `platform/` is the only place plugins are imported. Each adapter implements one port and nothing else.
3. `ui/` imports the engine's public API (`engine/index.ts`) and nothing deeper.

## 3.1 Layout (adapt names to the app's conventions; keep the boundaries)

```
src/chat/
  engine/
    index.ts                 public exports: ChatEngine, types, ports
    chat-engine.ts           the facade (section 5)
    ports.ts                 all port interfaces (section 4)
    timeline.ts              merge the library's list with the phone's copy; filter by the marker (8.1)
    rows.ts                  messages -> rows: day dividers, runs, emoji-only (8.2)
    emoji-only.ts            (8.3)
    history.ts               the pager (8.4)
    message-cache.ts         SQLite copy: schema, upsert, page, purge (section 7)
    media-cache.ts           200 MB file cache with LRU eviction (8.6)
    media-source.ts          local file or fresh link for a message (8.5)
    prepare-image.ts         photo -> JPEG rules (6.6)
    prepare-media.ts         what happens to each kind of picked file (6.6)
    voice.ts                 the recording state machine (8.7)
    composer.ts              draft, counters, send/mic toggle, typing throttle (6.4)
    errors.ts                library/engine errors -> i18n keys (section 9)
    purging-store.ts         the library's ChatStore on a key-value port, with purge (8.8)
    clear.ts                 Clear chat and sign-out wipe (8.8)
  platform/                  Capacitor adapters (one file per port)
  ui/                        chat page, bubbles, composer, pickers, viewer, emoji panel
  i18n/                      keys + English
  testing/                   fake ports, in-memory SqlPort over better-sqlite3, simulator harness, fixtures
```

---

# 4. Ports

All in `engine/ports.ts`. Every method may reject; the engine handles rejection (section 9). Keep them this small.

```ts
import type { Session } from '@vircle/chat-client'

/** Asks the Vircle backend (with the app's own sign-in) for a one-time chat connect token. Throws SessionAuthError on HTTP 401/403. */
export interface SessionPort { createSession(): Promise<Session> }
export class SessionAuthError extends Error {}

/** A random id created on first launch and kept in secure storage for the life of the install. */
export interface DeviceIdPort { get(): Promise<string> }

/** Small string storage (Capacitor Preferences). Keys are namespaced by the engine. */
export interface KeyValuePort {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
  keys(prefix: string): Promise<string[]>
}

/** SQLite. One database per signed-in person. */
export interface SqlPort {
  open(name: string): Promise<void>
  run(sql: string, params?: readonly (string | number | null)[]): Promise<{ changes: number }>
  all<T = Record<string, unknown>>(sql: string, params?: readonly (string | number | null)[]): Promise<T[]>
  transaction<T>(fn: () => Promise<T>): Promise<T>
  close(): Promise<void>
  deleteDatabase(name: string): Promise<void>
}

/** App-private files (the media cache). Paths are relative to a root the adapter owns. */
export interface FilePort {
  write(path: string, data: Blob): Promise<void>
  exists(path: string): Promise<boolean>
  remove(path: string): Promise<void>
  removeDir(path: string): Promise<void>
  /** A URL a WebView element can show: Capacitor.convertFileSrc(...) on device. */
  webUrl(path: string): Promise<string>
}

export type PickedFile = { blob: Blob; name: string; type: string; width?: number; height?: number }
export type Permission = 'granted' | 'denied' | 'blocked'   // blocked = must be changed in system settings

export interface MediaPickerPort {
  pickDocument(): Promise<PickedFile[]>          // PDF, Word, Excel, PowerPoint, text
  pickPhotosAndVideos(): Promise<PickedFile[]>   // photo library, multiple
  pickAudio(): Promise<PickedFile[]>
  capture(kind: 'photo' | 'video'): Promise<PickedFile | null>   // null = the person cancelled
  ensurePermission(what: 'camera' | 'photos' | 'microphone'): Promise<Permission>
  openAppSettings(): Promise<void>
}

/** Native fallback for pictures the WebView cannot decode (for example HEIC on Android). Returns a JPEG. */
export interface ImageConvertPort { toJpeg(file: PickedFile): Promise<Blob> }

/** On-device H.264 MP4 transcode. */
export interface VideoTranscodePort {
  transcode(file: PickedFile, opts: { maxHeight: number; videoBitrateBps: number }, onProgress: (fraction: number) => void): Promise<Blob>
}

/** A native recorder producing AAC (WebView MediaRecorder gives WebM/Opus on Android, which the gateway refuses). */
export interface RecorderPort {
  start(): Promise<void>
  stop(): Promise<{ blob: Blob; mimeType: string; durationSeconds: number }>
  cancel(): Promise<void>
}

/** Save to the phone's photo gallery. Only called after the person taps Save. */
export interface GalleryPort { saveImage(blob: Blob, name: string): Promise<void>; saveVideo(blob: Blob, name: string): Promise<void> }

/** Open or share a document or audio file (system viewer, share sheet). */
export interface ShareOpenPort { open(blob: Blob, name: string, mime: string): Promise<void> }

export interface LifecyclePort {
  onForeground(cb: () => void): () => void
  onBackground(cb: () => void): () => void
  onUrlOpen(cb: (url: string) => void): () => void   // deep links
}

export interface BadgePort { set(count: number): Promise<void> }
export interface ClockPort { now(): number }
export interface LoggerPort { debug(code: string, data?: Record<string, number | string | boolean>): void; warn(code: string, data?: Record<string, number | string | boolean>): void }

/** Decides what the app does with a push payload; payload fields are not final (push team). */
export interface PushRoutingPort { isChatAlert(payload: unknown): boolean }
```

Test doubles for every port live in `testing/`. The `SqlPort` double wraps `better-sqlite3` (devDependency) so the real SQL runs in tests.

---

# 5. The engine's public API

## 5.1 Construction and lifecycle

```ts
export interface EngineConfig {
  chatBaseUrl: string            // https://chat.vircle.tech
  appVersion: string
  cacheMaxBytes?: number         // default 200 * 1024 * 1024
  pageSize?: number              // default 30
  recentHydrate?: number         // default 50 (rows read from the copy at start)
}
export declare function createChatEngine(ports: ChatEnginePorts, config: EngineConfig): ChatEngine   // you implement this (T02)

export interface ChatEngine {
  /** After sign-in. Opens the person's database, starts the library, shows what is kept at once, then connects. */
  start(ctx: { walletId: string }): Promise<void>
  /** Sign-out: stops the library and removes everything kept for this person (8.8). Idempotent. */
  signOut(): Promise<void>
  /** App signed in again after a 401: starts again with the same wallet without wiping. */
  resume(): Promise<void>

  subscribe(fn: () => void): () => void
  getState(): ChatViewState                 // immutable, replaced on every change (works with useSyncExternalStore / signals)

  setScreenVisible(visible: boolean): void  // the chat page is the active page
  reconnectNow(): void

  // composer
  sendText(text: string, opts?: { replyToId?: string }): Promise<void>
  sendFile(file: PreparedFile, opts?: { caption?: string; replyToId?: string }): Promise<void>
  typing(): void
  retry(messageId: string): Promise<void>
  discard(messageId: string): void

  // history and media
  loadOlder(): Promise<void>
  getMediaSource(messageId: string, opts?: { intent?: 'show' | 'open' }): Promise<MediaSource>   // default 'show'
  saveToGallery(messageId: string): Promise<void>

  // chat management
  clearChat(): Promise<void>

  /** Returns true if the URL was a chat deep link (the app then navigates to the chat page). */
  handleDeepLink(url: string): boolean
  isScreenVisible(): boolean
}

export type PreparedFile = { blob: Blob; name: string; type: string; durationSeconds?: number }
export type MediaSource = { url: string; cached: boolean }
```

## 5.2 What the screen reads

```ts
export type ChatRow =
  | { kind: 'day'; key: string; dayKey: string; at: number }     // dayKey 'YYYY-MM-DD' in the person's zone; at = the first message's time that day
  | { kind: 'message'; key: string; message: ChatMessage; showSender: boolean; groupStart: boolean; groupEnd: boolean; emojiOnly: boolean }

export interface ChatViewState {
  connection: { state: ConnectionState; nextAttemptAt: number | null; lastError: ChatErrorInfo | null; authRequired: boolean }
  rows: readonly ChatRow[]
  initialLoading: boolean            // true until the first load finished AND there are no rows: show a spinner
  supportTyping: boolean
  unreadCount: number
  limits: Limits | null
  history: { phase: 'idle' | 'loading' | 'error'; end: null | 'start' | 'window' | 'cleared'; canLoadMore: boolean; error: string | null }
  pendingCount: number               // messages sending or failed
}
```

`ChatMessage`, `ConnectionState`, `ChatErrorInfo`, `Limits` come from the library (Appendix A).

## 5.3 Rules the engine guarantees to the screen

- `getState()` returns a new object whenever anything visible changes, and the same object otherwise.
- `rows` are in display order, oldest first; `key` is stable across updates (use it as the list key).
- A message the person is sending is in `rows` immediately with `status: 'sending'`.
- Nothing in `rows` is older than the cleared-before marker, except messages still `sending` or `failed`.
- The engine never throws from `subscribe` callbacks' perspective; failures appear in state (`connection.lastError`, a message's `status:'failed'`, `history.phase:'error'`) or as a rejected promise on the action that caused them.

## 5.4 The library call Phase B needs (built: library 1.1.0)

Program against this. A 1.0.0 library has no such call, so the engine still detects its absence (`typeof (chat as { fetchHistory?: unknown }).fetchHistory !== 'function'`)
and behaves as in 8.4 "Phase A".

```ts
interface HistoryRequest { before: { sentAt: number; serverId?: string }; limit?: number /* 1..50, default 30 */; notBefore?: number }   // serverId omitted when the engine holds no message
interface HistoryPage { messages: ChatMessage[]  /* oldest first; seq null; id === serverId; media.url a fresh 24 h link */; more: boolean; end: 'start' | 'window' | null }
// VircleChatClient.fetchHistory(req: HistoryRequest): Promise<HistoryPage>
// rejects with ChatError.code in: 'history_unavailable' | 'history_disabled' | 'rate_limited' | 'offline' | 'bad_request' | 'timeout'
//   (ChatError.retryAfterSeconds, when set, is how long to wait before asking again; 'history_disabled' means stop asking)
```

It does not add the messages to the library's own list, sends no receipts and counts nothing as unread. The engine owns what happens next.
`media.url` of a history message is a link to the gateway good for 24 hours; **the first open of an old file takes a moment** (the gateway fetches it from Halo),
and `media.fileName` / `sizeBytes` may be empty. Renew an expired link with `chat.getMediaUrl(message)`, which since 1.1.0 accepts the message itself (a history
message is not in the library's list). `fetchHistory` rejects `history_disabled` at once on a gateway that does not offer history. Pages are limited to 10 a minute.

---

# 6. Requirements

IDs are for tests and commits (`R-...`). "The screen" means the UI layer; "the engine" means `engine/`.

## 6.1 Connection and lifecycle

- **R-CONN-1** `start({walletId})` builds one `VircleChatClient` with: `baseUrl = config.chatBaseUrl`, `deviceId` from `DeviceIdPort`,
  `appVersion`, `store = PurgingStore(keyValue, 'vircle-chat:'+walletId)` (8.8), and `getSession = wrap(SessionPort.createSession)`.
  It then opens `SqlPort` database `vircle-chat-<walletId>`, runs the schema (section 7), calls `client.start()` and returns.
- **R-CONN-2** `getSession` is called by the library before **every** connection; the engine must not cache the token.
- **R-CONN-3** If `createSession` throws `SessionAuthError`, the engine calls `client.stop()`, sets `connection.authRequired = true`, and does not
  retry. (The library cannot tell 401 from a network failure and would retry forever.) Any other failure is left to the library's backoff.
  `resume()` starts it again after the app signed the person in again.
- **R-CONN-4** App returns to foreground: `client.reconnectNow()` and `setScreenVisible` re-evaluates (R-CONN-5).
- **R-CONN-5** `client.setScreenOpen(true)` only while the chat page is the active page **and** the app is in the foreground; `false` in every
  other case, including the app going to the background with the chat page on top. (Otherwise messages are reported "read" that nobody saw.)
- **R-CONN-6** Deep link `https://app.vircle.com/chat/{conversation_id}` (`/^https:\/\/app\.vircle\.com\/chat\/[\w-]+/`; the older `https://app.vircle.com/chat/{conversation_id}` is accepted too): `handleDeepLink` returns true and the app navigates to
  the chat page; the engine calls `reconnectNow()`. Any other URL returns false.
- **R-CONN-7** `connection.state === 'replaced'`: the screen shows "Chat is open on another screen" and a **Reconnect** button calling
  `reconnectNow()`. The engine never reconnects by itself in this state.
- **R-CONN-8** When `connection.state` is not `online` the screen shows a thin bar ("Connecting..." for `connecting`/`idle`, "Waiting for
  network" for `offline`). It never blocks the screen: typing and sending keep working (messages queue).

## 6.2 The list

- **R-LIST-1** Order, grouping and day dividers per 8.1 and 8.2.
- **R-LIST-2** Message drawing per the table in 6.3.
- **R-LIST-3** Stay at the bottom when a message arrives and the person was within **120 px** of the bottom; otherwise do not move the list
  and show a **New messages** pill (with the count) that scrolls to the bottom when tapped. Opening the chat scrolls to the bottom after the
  first render **and again** after images above the fold have loaded (reserve a 240-point-wide box for media so layout is stable).
- **R-LIST-4** Keyboard opens: the list keeps the last message visible (scroll to bottom if the person was within 120 px of it). Composer sits
  in the page footer, above the keyboard and the safe area (`env(safe-area-inset-bottom)`); header uses `env(safe-area-inset-top)`.
- **R-LIST-5** Lists longer than a few hundred rows must be virtualised with dynamic row heights.
- **R-LIST-6** `initialLoading` shows a centred spinner only while true; the connection bar is separate.
- **R-LIST-7** Support is typing: a "Support is typing..." line above the composer while `supportTyping`.
- **R-LIST-8** Scroll position is **never** disturbed by older messages being added above (8.9).

## 6.3 Drawing a message

| Message | Draw |
| --- | --- |
| Mine, `text` | Right-aligned bubble; time and ticks under it |
| Support, `text` | Left-aligned bubble; sender name above when `showSender` |
| `replyTo` set | A quoted block inside the bubble: "You" or "Support", then a one-line preview (140 characters); for a quoted file with no caption the word "Photo" (image) or the kind's word |
| `image` | Thumbnail at most 240 points wide; tap opens the viewer; caption below |
| `video` | Poster frame (first frame, or a generic tile until loaded) with a play icon; tap opens the viewer; caption below |
| `video` with `media.animated` | A **GIF**: `<video autoplay loop muted playsinline>`, no controls, small "GIF" tag; tap may open it larger |
| `audio` | Voice-note player: play/pause, progress bar, length from `durationSeconds` (`0:12`); optional speed 1x/1.5x/2x |
| `document` | A chip: file-type icon, `fileName`, size; tap opens it (R-MEDIA-5) |
| Emoji only (up to 3) | Large emoji, no bubble background (`emojiOnly`) |
| Day change | Centred divider: "Today", "Yesterday", or the date in the person's format |

**Ticks** on the person's own messages: `sending` clock; `sent` one grey tick; `delivered` two grey; `read` two blue; `failed` red exclamation
with **Retry** and **Delete**. A status only moves forward (the library guarantees it). Every tick has a text alternative (section 10).

## 6.4 The composer

- **R-COMP-1** One text field growing up to 5 lines; then it scrolls inside. Placeholder "Message".
- **R-COMP-2** Left of the field the emoji button; right the **+** (attach) button; at the far right **Send** when the trimmed text is non-empty,
  otherwise the **microphone**.
- **R-COMP-3** Send is disabled for whitespace-only text. Text longer than `limits.textMax` (default 4000, counted as JavaScript counts
  characters) cannot be sent; show a counter from 90% of the limit.
- **R-COMP-4** On every input event with non-empty text call `engine.typing()` (the library throttles to once per 2.5 s).
- **R-COMP-5** Reply: swipe a bubble right by 64 px (or the **Reply** action of its long-press menu) sets the reply bar above the composer
  (sender and one-line preview, a close button). The next send carries `replyToId`; the bar clears after sending. A message without
  `serverId` yet cannot be quoted (the action is hidden).
- **R-COMP-6** A draft (unsent text) survives leaving the page, and closing the app, per person: `KeyValuePort` key `vircle-chat:<wallet>:draft`.
  Cleared on send, Clear chat and sign-out.
- **R-COMP-7** Sending text: `await engine.sendText(text, {replyToId})`; clear the field at once (optimistic); the message appears as `sending`.
  Rejections (`message_too_long`, `bad_request`) are mapped per section 9; never lose the person's text: on a pre-send rejection restore it.

## 6.5 The attach menu

- **R-ATT-1** The **+** opens an action sheet (phone) or popover, entries in this order: **Document**, **Photos & videos**, **Camera**, **Audio**.
  No GIF, Location, Contact or Poll.
- **R-ATT-2** Permissions via `MediaPickerPort.ensurePermission`. `denied` shows a short explanation and asks again next time; `blocked`
  shows a dialog with **Open settings** (`openAppSettings`).
- **R-ATT-3** After picking, a **preview screen** shows each file (image/video poster, file name and size for others) with a caption field
  (max `limits.captionMax`, default 1024) and **Send** / **Cancel**. Several files: one preview each with its own caption, sent in order.
- **R-ATT-4** Camera: photo via the Camera plugin (`format: jpeg`); video via a plugin that records video or a file input with `capture`
  (to our knowledge `@capacitor/camera` takes photos only: confirm on your Capacitor version; the choice is an adapter detail).
- **R-ATT-5** The message appears in the list at once as `sending` with a local preview; the person never waits for the upload.

## 6.6 Preparing files (the library does not)

`prepare-media.ts` runs before the preview screen's Send; the result is a `PreparedFile`.

| Kind | Rule |
| --- | --- |
| Photo | Always re-encode as **JPEG**, longest side at most **1,600 px**, quality **0.8**, honour EXIF orientation, fill transparency with white, **strip all metadata** (no GPS). HEIC/HEIF or anything the WebView cannot decode: try `ImageConvertPort.toJpeg`; if that fails, error `image_unsupported`. Name `*.jpg`. |
| Video | Accept MP4 or 3GPP up to **8 MB** unchanged. Anything else, or larger: `VideoTranscodePort.transcode` (H.264 MP4, AAC audio, height at most **720**, video bitrate **1.5 to 2 Mbps**) with a progress bar and a cancel button. If the result is still over `limits.fileMaxBytes` (default 16 MB): error `video_too_long` ("Trim it to about 30 seconds"). |
| Audio file | Must be one of: Ogg, MP3, AAC, MP4 audio, AMR (`ALLOWED_MIME_TYPES`); at most 16 MB. No processing. |
| Document | Must be PDF, Word (`.doc`, `.docx`), Excel (`.xls`, `.xlsx`), PowerPoint (`.ppt`, `.pptx`), plain text; at most 16 MB. No processing. |
| Voice note | Comes from `RecorderPort` as AAC (`audio/aac` or `audio/mp4`); see 8.7. |

Refuse everything else before showing the preview, with the message for `file_type_not_allowed` (section 9). A `.gif` file is refused the same way.

## 6.7 Showing media

- **R-MEDIA-1** `engine.getMediaSource(messageId)` returns `{url, cached}` per 8.5. The screen calls it when a media bubble is about to be
  shown (not for every row at once: only rows near the viewport) and again before opening the viewer.
- **R-MEDIA-2** **Cache on first show** (D5): images, voice notes and GIFs are saved into the file cache the first time they are shown;
  videos and documents the first time they are **opened**. Total cap **200 MB (209,715,200 bytes)**, least recently used removed first (8.6).
- **R-MEDIA-3** The viewer: image full screen with pinch zoom; video with controls; GIF (`animated`) looping, muted, no controls. Close button
  and swipe-down to close. A **Save to gallery** action for images and videos (R-MEDIA-6).
- **R-MEDIA-4** A file sent by the person is added to the cache as soon as it is stored (when its `serverId` appears), from the prepared file,
  so it also shows offline later.
- **R-MEDIA-5** A document or audio file opens through `ShareOpenPort.open` (system viewer or share sheet). Never expect a link to work later.
- **R-MEDIA-6** **Save to gallery**: only on tap; images and videos only (voice notes and documents are not gallery items: the share sheet is
  their route); gets the file from the cache or downloads it; calls `GalleryPort`; then a confirmation ("Saved to your gallery"). Permission
  denied -> R-ATT-2 flow. The copy in the gallery is the person's: **never** removed by Clear chat or sign-out, **not** counted in the 200 MB.
- **R-MEDIA-7** If a link fails (HTTP 410 or an `<img>` error), call `getMediaSource` again once; if that fails show a tile "Could not open this
  file" with Retry.

## 6.8 Voice notes

- **R-VOICE-1** While the text field is empty the microphone replaces Send. Press and hold records; a timer and "Slide left to cancel" appear;
  release sends; slide up to lock.
- **R-VOICE-2** State machine and thresholds exactly as 8.7. Maximum **5 minutes**; at 5:00 it stops and sends.
- **R-VOICE-3** Format AAC via `RecorderPort`, with an accurate `durationSeconds` (the library's `sendFile` option). If the recorder cannot report
  the duration, measure it from the timer.
- **R-VOICE-4** Starting a recording stops any voice note that is playing. Only one note plays at a time.

## 6.9 Emoji

- **R-EMO-1** The emoji button toggles a bottom panel (replacing the keyboard) with category tabs (smileys, people, animals, food, travel,
  activities, objects, symbols, flags), a **search** box, and a **recent** tab (last 30, kept per person in `KeyValuePort`).
- **R-EMO-2** Tapping an emoji inserts it at the cursor and keeps the panel open. Data from `emoji/emoji.js` (see
  `simulator/public/simulator.js`, function `buildEmoji`, for how to read it). Skin tones are normal sequences and send like text.
- **R-EMO-3** Emoji need no special sending code: they go through `sendText` unchanged.

## 6.10 History, the copy on the phone, Clear chat, sign-out

- **R-HIST-1** The engine keeps **every message it sees** (with status `sent`, `delivered` or `read`, newer than the marker) in its SQLite copy
  (section 7), updates it when a status changes, and shows it again at once next launch, offline. App updates, restarts, offline and network
  changes never remove it.
- **R-HIST-2** Scrolling up near the top (within **1.5 screen heights** of it) calls `engine.loadOlder()`: **30 messages**, newest to oldest,
  first from the copy on the phone, then (Phase B) from Halo through `fetchHistory`. One request at a time.
- **R-HIST-3** While a page loads the screen shows a small spinner row above the oldest message. It never blocks the screen.
- **R-HIST-4** When there is nothing more, `history.end` says why: `start` (first message ever: nothing extra), `window` (older exists but beyond
  90 days: a quiet line "Earlier messages are not shown"), `cleared` (the person cleared the chat: nothing shown).
- **R-HIST-5** A failed page shows the row "Could not load earlier messages. Tap to try again", which calls `loadOlder()`. No automatic retry loop.
- **R-HIST-6** Older messages are never counted as unread and never produce receipts.
- **R-CLEAR-1** **Clear chat** is in the chat page's overflow menu. It asks first (text in section 10). On confirm `engine.clearChat()` removes
  **every** cached message, every cached file, the library's kept copy of the cleared messages, and the draft; sets the cleared-before marker;
  messages still `sending` or `failed` are kept. It touches nothing in Halo and nothing in the phone's gallery.
- **R-CLEAR-2** After Clear chat, scrolling up finds nothing older (`history.end = 'cleared'`). New messages after the marker appear normally.
- **R-SIGNOUT-1** `engine.signOut()` (decision D4): stops the library, calls `clearLocal()`, deletes the database, the cached files, the marker, the
  draft, recents, and every `vircle-chat:<wallet>:` key; sets the badge to 0. The next sign-in (same or another person) starts empty and loads
  up to 90 days as the person scrolls. The **device id stays** (it belongs to the install).
- **R-SIGNOUT-2** Account switch = `signOut()` then `start()` with the new wallet.

## 6.11 Badge, notifications, push

- **R-BADGE-1** While the chat page is visible `unreadCount` is 0 (library). When the app goes to the background, `BadgePort.set(unreadCount)`.
- **R-PUSH-1** When a push arrives while the app is in the foreground **and** the chat page is visible and `PushRoutingPort.isChatAlert(payload)`,
  show nothing. If the app is open on another page, show the app's usual in-app banner.
- **R-PUSH-2** Tapping a chat alert: deep link (R-CONN-6). The alert's data is `{ notification_type: '01', chat_alert: '1', conversation_id, deep_link }` (strings);
  `PushRoutingPort.isChatAlert` is `data.chat_alert === '1'` and nothing else. The push team has still to confirm that the push API forwards those fields.

## 6.12 Quality

- **R-A11Y-1** Each bubble reads as "Support, 10:42, <text>" or "You, 10:43, delivered, <text>"; GIFs read "GIF"; ticks and icons have text
  alternatives; the composer controls have labels; the viewer is focus-trapped; the player is operable by assistive technology.
- **R-A11Y-2** Respects the system text size (Ionic dynamic font scaling) up to the largest setting without clipping.
- **R-THEME-1** Light and dark: every colour is a theme token; "mine" and "support" bubbles keep a contrast pair of at least 4.5:1 text contrast
  in both themes.
- **R-I18N-1** Every visible word comes from the app's i18n through the keys in section 10. No hard-coded user-visible text. Dates and times use
  `Intl` with the app's locale.
- **R-SEC-1** No secret anywhere; no logging of content (0.3); CSP allows `https://chat.vircle.tech` and `wss://chat.vircle.tech` in `connect-src`,
  and the same host (plus `blob:` and `data:`) in `img-src` and `media-src`.
- **R-SEC-2** TLS only. If Vircle's other APIs pin certificates, pin `chat.vircle.tech` the same way (decision pending with Security).

---

# 7. Data: the copy on the phone

## 7.1 SQLite schema (one database per person: `vircle-chat-<walletId>`)

```sql
-- schema version 1
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  key       TEXT PRIMARY KEY,     -- server_id (always present: only stored messages are kept)
  id        TEXT NOT NULL,        -- the library's message id (stable list key)
  seq       INTEGER,              -- null for messages that came from history
  sent_at   INTEGER NOT NULL,     -- milliseconds since the epoch
  mine      INTEGER NOT NULL,     -- 0 or 1
  kind      TEXT NOT NULL,        -- text | image | video | audio | document
  text      TEXT,
  sender    TEXT,
  status    TEXT NOT NULL,        -- sent | delivered | read
  reply_to  TEXT,                 -- JSON of the Quote, or null
  media     TEXT                  -- JSON of ChatMedia WITHOUT url and expiresAt (links expire); null for text
);
CREATE INDEX IF NOT EXISTS messages_time ON messages (sent_at, key);

CREATE TABLE IF NOT EXISTS media_files (
  key         TEXT PRIMARY KEY,   -- the message key (server_id)
  path        TEXT NOT NULL,      -- relative to the file port's root
  mime        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  last_access INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS media_files_access ON media_files (last_access);
```

`meta` keys: `schema_version` (`1`), `cleared_before` (milliseconds, absent if never cleared).

Migrations: keep an ordered list of statements; run those above `schema_version` in one transaction; never edit a released migration.

## 7.2 What is persisted, and what is not

- **Persisted:** messages whose status is `sent`, `delivered` or `read` **and** `sent_at > cleared_before`. Keyed by `serverId`.
- **Never persisted:** `sending`/`failed` messages (the library keeps those itself), `media.url`, `media.expiresAt`, anything with a token.
- **Written in batches:** collect changes and write them in one transaction at most every 300 ms, and on `setScreenVisible(false)` and on
  background. After `start`, **reconcile once**: upsert everything in the library's first snapshot (this also adopts the messages the library
  kept from before).
- **Encryption at rest:** the adapter's business (7.4); the schema is the same.

## 7.3 Key-value keys (`KeyValuePort`), all prefixed `vircle-chat:<walletId>:`

`state` (the library's own kept state, JSON, via `PurgingStore`), `draft`, `recent-emoji`. The marker lives in SQLite `meta`.
The device id is stored separately by `DeviceIdPort` (not under this prefix, survives sign-out).

## 7.4 Adapters

`SqlPort` on a Capacitor SQLite plugin. If Security requires encryption at rest: the plugin's encrypted mode, key in the iOS keychain / Android
keystore, one key per install. The engine does not change.

---

# 8. Algorithms

## 8.1 The timeline: the library's list plus older messages from the copy

```ts
const keyOf = (m: ChatMessage) => m.serverId ?? m.id

/** libraryMessages: snapshot.messages (in the library's order). olderLoaded: pages read from the copy / Halo so far, oldest first. */
export function buildTimeline(libraryMessages: readonly ChatMessage[], olderLoaded: readonly ChatMessage[], clearedBefore: number): ChatMessage[] {
  const live = libraryMessages.filter((m) => isPending(m) || m.sentAt > clearedBefore)
  const have = new Set(live.map(keyOf))
  const older = olderLoaded.filter((m) => m.sentAt > clearedBefore && !have.has(keyOf(m)))
  return [...older, ...live]    // the library's list is authoritative from its first message on; older ones all come before it
}
const isPending = (m: ChatMessage) => m.status === 'sending' || m.status === 'failed'
```

`olderLoaded` is kept sorted by `sentAt`, then `key`, ascending, with duplicates removed by key. The paging cursor is the first element of the
timeline (its `sentAt` and key).

## 8.2 Rows: day dividers and runs

```ts
const GROUP_GAP_MS = 5 * 60_000
/** The calendar date of `ms` in `zone` as 'YYYY-MM-DD' ('en-CA' formats that way). Right across daylight-saving changes, unlike "midnight plus 24 hours". */
export function dayKeyOf(ms: number, zone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
}
/** The date before a 'YYYY-MM-DD' key, by calendar arithmetic (no time zone involved). */
export function previousDayKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10)
}

export function toRows(timeline: readonly ChatMessage[], zone = Intl.DateTimeFormat().resolvedOptions().timeZone): ChatRow[] {
  const rows: ChatRow[] = []
  let prev: ChatMessage | null = null
  let lastDay = ''
  for (const m of timeline) {
    const day = dayKeyOf(m.sentAt, zone)
    if (day !== lastDay) { rows.push({ kind: 'day', key: `d${day}`, dayKey: day, at: m.sentAt }); lastDay = day; prev = null }
    const sameRun = prev && prev.mine === m.mine && (prev.sender ?? '') === (m.sender ?? '') && m.sentAt - prev.sentAt <= GROUP_GAP_MS
    rows.push({ kind: 'message', key: m.id, message: m, showSender: !m.mine && !sameRun && !!m.sender, groupStart: !sameRun, groupEnd: true, emojiOnly: isEmojiOnly(m) })
    if (sameRun) { const last = rows[rows.length - 2]; if (last?.kind === 'message') last.groupEnd = false }
    prev = m
  }
  return rows
}
```

A new day divider appears exactly when the **calendar date** changes in the person's time zone. Do not compute "midnight" with `Date#setHours` or
by adding 24 hours: days are 23 or 25 hours long when daylight saving changes. The screen builds the label from the row: `dayKey` equal to
`dayKeyOf(now, zone)` is "Today", equal to `previousDayKey(thatKey)` is "Yesterday", otherwise the date formatted from `at` with `Intl` in the app's
locale. Labels are never stored.

## 8.3 Emoji-only

```ts
const seg = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2})/u
export function isEmojiOnly(m: ChatMessage): boolean {
  if (m.kind !== 'text' || !m.text || !seg) return false
  const t = m.text.trim()
  if (!t || t.length > 40) return false
  const parts = [...seg.segment(t)].map((s) => s.segment)
  return parts.length >= 1 && parts.length <= 3 && parts.every((p) => EMOJI.test(p))
}
```

Test cases that must hold: `"😀"` true; `"😀👍🏽🇲🇾"` true (skin tone, flag); `"👨‍👩‍👧"` true (joined family counts as one); `"😀😀😀😀"` false (four);
`"A😀"` false; `"😀 hello"` false; `"1️⃣"` false (keycap: shown as normal text, acceptable); `""` and whitespace false; a quoted file message false.

## 8.4 The pager

```ts
async function loadOlder(): Promise<void> {
  const h = state.history
  if (h.phase === 'loading' || h.end !== null || !h.canLoadMore) return
  setHistory({ phase: 'loading', error: null })
  try {
    const cursor = firstOfTimeline() ?? { sentAt: clock.now(), key: undefined }   // the oldest row held; with none held, "older than now"

    // 1. The phone's own copy.
    const page = cursor.key ? await cache.olderThan(cursor.sentAt, cursor.key, pageSize, clearedBefore) : []   // newest first, strictly older, > clearedBefore
    if (page.length > 0) { prepend(page.reverse()); return setHistory({ phase: 'idle' }) }

    // 2. Halo (Phase B). Needs library 1.1.0 (a 1.0.0 library has no fetchHistory).
    if (!hasFetchHistory) return setHistory({ phase: 'idle', canLoadMore: false, end: clearedBefore > 0 ? 'cleared' : null })   // Phase A: nothing older is available; no claim about the start
    const res = await chat.fetchHistory({ before: { sentAt: cursor.sentAt, serverId: cursor.key }, limit: pageSize, notBefore: clearedBefore || undefined })
    const fresh = res.messages.filter((m) => m.sentAt > clearedBefore)
    await cache.upsert(fresh.map(stripLinks))               // never keep media.url / expiresAt
    prepend(fresh)
    const end = res.more ? null : clearedBefore > 0 ? 'cleared' : (res.end ?? 'start')   // after Clear chat any terminal answer reads as 'cleared'
    setHistory({ phase: 'idle', end, canLoadMore: res.more })
  } catch (e) {
    setHistory({ phase: 'error', error: codeOf(e) })        // history_unavailable, offline, rate_limited ...
  }
}
```

- A page read from the copy that is **shorter** than the page size does not mean "end": the next call finds nothing in the copy and goes to Halo.
- Once a marker is set (`clearedBefore > 0`) every terminal answer reads as `'cleared'`: the person sees nothing extra, whatever Halo says.
- With no message held at all (a fresh install whose last 30 days were empty) the first call asks Halo for messages older than "now".
- `history.error` holds only a code.
- The screen calls `loadOlder()` on scroll (R-HIST-2) and also once after first render when the content is shorter than the viewport
  (including an empty list, which is how a freshly cleared chat settles to `'cleared'`).

SQL for `olderThan`:

```sql
SELECT * FROM messages
WHERE (sent_at < ?1 OR (sent_at = ?1 AND key < ?2)) AND sent_at > ?3
ORDER BY sent_at DESC, key DESC
LIMIT ?4
```

## 8.5 `getMediaSource`

```ts
async function getMediaSource(messageId: string): Promise<MediaSource> {
  const m = findMessage(messageId)
  if (!m?.media) throw new EngineError('not_found')
  const key = m.serverId
  if (key) {
    const row = await mediaCache.get(key)                       // touches last_access
    if (row && await files.exists(row.path)) return { url: await files.webUrl(row.path), cached: true }
  }
  const url = await chat.getMediaUrl(m.id)                      // may reject: not_found, not_ready, offline, timeout
  return { url, cached: false }
}
```

**Caching** (R-MEDIA-2): when `getMediaSource` returns a remote link (`cached: false`) the engine then schedules `cacheInBackground(message, url)`
if `intent` is `'show'` and the message is an image, a voice note or an animated video (GIF), or if `intent` is `'open'` and it is any other
video or a document. Otherwise the call has no side effect except touching `last_access`. Downloads run one at a time, never while the
connection is offline, and never block the UI; a failed download is dropped silently and tried again the next time the file is shown.

## 8.6 The 200 MB media cache

```ts
const CAP = config.cacheMaxBytes ?? 200 * 1024 * 1024   // 209,715,200
async function add(key: string, blob: Blob, mime: string): Promise<void> {
  if (blob.size > CAP) return                           // never cache a file larger than the whole cache
  const path = `media/${walletId}/${key}`
  await files.write(path, blob)
  await sql.run('INSERT OR REPLACE INTO media_files (key, path, mime, bytes, last_access) VALUES (?,?,?,?,?)', [key, path, mime, blob.size, clock.now()])
  await evict()
}
async function evict(): Promise<void> {
  let [{ total }] = await sql.all<{ total: number }>('SELECT COALESCE(SUM(bytes),0) AS total FROM media_files')
  while (total > CAP) {
    const [victim] = await sql.all<{ key: string; path: string; bytes: number }>('SELECT key, path, bytes FROM media_files ORDER BY last_access ASC LIMIT 1')
    if (!victim) break
    await files.remove(victim.path); await sql.run('DELETE FROM media_files WHERE key = ?', [victim.key]); total -= victim.bytes
  }
}
```

Eviction never touches the SQLite messages and never the gallery. A row whose file is missing is deleted on the next `get`.

## 8.7 Voice recording state machine

States: `idle`, `recording`, `cancelArmed`, `locked`. Events and thresholds:

| From | Event | To / action |
| --- | --- | --- |
| idle | press | `ensurePermission('microphone')`: granted -> `RecorderPort.start()`, stop any playing note, -> recording; denied/blocked -> R-ATT-2 flow, stay idle |
| recording | move left by more than **80 px** | cancelArmed (UI turns red, "Release to cancel") |
| cancelArmed | move back right of the threshold | recording |
| recording | move up by more than **80 px** | locked (UI shows Stop and Delete buttons) |
| recording | release, elapsed under **1 s** | `cancel()`, discard, hint "Hold to record" |
| recording | release | `stop()` -> send |
| cancelArmed | release | `cancel()`, discard |
| locked | Stop tap | `stop()` -> send |
| locked | Delete tap | `cancel()`, discard |
| any recording state | elapsed reaches **300 s** | `stop()` -> send |
| any recording state | app goes to background, call interrupts, recorder error | `cancel()`, discard |

Send = `engine.sendFile({ blob, name: 'voice-note.m4a', type: mimeType.split(';')[0], durationSeconds: Math.round(durationSeconds) })`.
If `mimeType` is not one of the allowed audio types, discard and show the `voiceFormat` error (section 9). The machine is a pure reducer
`(state, event) -> {state, effects}` in `voice.ts`, tested without a recorder.

## 8.8 Store, Clear chat, sign-out

**`PurgingStore`** implements the library's `ChatStore` on `KeyValuePort`:

```ts
interface PurgingStore extends ChatStore { purgeUpTo(markerMs: number): Promise<void> }
// load():  parse JSON at 'vircle-chat:<wallet>:state'
// save(s): write it, dropping messages with sentAt <= clearedBefore unless pending (sending/failed)
// clear(): remove the key
// purgeUpTo(marker): load, drop messages with sentAt <= marker (keep pending), save back (does not touch lastSeq or the pending queue)
```

**Clear chat:**

```ts
async function clearChat(): Promise<void> {
  const held = timeline.filter((m) => !isPending(m)).map((m) => m.sentAt)
  const newest = Math.max(clearedBefore, ...held, await cache.maxSentAt())
  if (newest > 0) {
    await sql.run("INSERT OR REPLACE INTO meta (k, v) VALUES ('cleared_before', ?)", [String(newest)])   // the marker lives in SQLite only
    clearedBefore = newest
    await sql.run('DELETE FROM messages WHERE sent_at <= ?', [newest])
    await store.purgeUpTo(newest)                              // the library's own kept copy
  }
  await mediaCache.removeAll()                               // DELETE FROM media_files + files.removeDir('media/<wallet>')
  await kv.remove(draftKey); olderLoaded = []
  setHistory({ phase: 'idle', end: null, canLoadMore: true, error: null })   // the next loadOlder settles it to 'cleared' (8.4)
  publish()
}
```

The marker is the time of the **newest** message held, not "now", so a phone whose clock is ahead of the server cannot hide new messages.
Everything at or before it is gone and never fetched again; later messages show normally. Do **not** call the library's `clearLocal()`: it would
reset `lastSeq` and make the gateway replay 30 days of messages.

**Sign-out:** `chat.stop()`; `await chat.clearLocal()`; `sql.close()`; `sql.deleteDatabase(name)`; `files.removeDir('media/<wallet>')`;
`kv.keys('vircle-chat:<wallet>:')` then remove each; `badge.set(0)`; reset the engine's state. Safe to call twice.

## 8.9 Keeping the reading position when older messages are added

```ts
// In the screen, around the update that prepends rows:
const anchor = firstFullyVisibleRowElement(scroller)          // before the update
const beforeTop = anchor.getBoundingClientRect().top
/* ...apply the new rows, wait for the DOM to update (one animation frame)... */
const afterTop = anchor.getBoundingClientRect().top           // same element, found by its row key
scroller.scrollTop += afterTop - beforeTop                    // no animation
```

Do not rely on CSS `overflow-anchor` (iOS WebViews do not support it). With a virtualised list use its keep-position option plus the anchor
correction. Test: prepend 30 rows and assert the anchor row's offset changed by less than 1 px.

---

# 9. Errors: what the screen shows

The library rejects with `ChatError` (`.code`). `errors.ts` maps a code to an i18n key and a behaviour. Unknown codes use `chat.error.generic` and are logged by code.

| Code | Where | Key | Behaviour |
| --- | --- | --- | --- |
| `message_too_long` | sendText | `chat.error.tooLong` | Prevented by the counter; on rejection restore the text |
| `file_too_large` | sendFile | `chat.error.fileTooBig` | Refuse before upload |
| `file_type_not_allowed`, `gif_must_be_mp4` | sendFile, picking | `chat.error.fileType` | Refuse before preview |
| `bad_request` | send | none | Log; ignore |
| `rate_limited` | send | none | The library waits and sends; no message |
| `upload_failed`, `network`, `timeout`, `offline` | send | none | Message becomes `failed`; Retry and Delete |
| `queue_full` | send | `chat.error.queueFull` | Block new sends until some are delivered |
| `not_found`, `not_ready`, `bad_response` | getMediaUrl | `chat.error.openFile` | Tile with Retry (R-MEDIA-7) |
| `unauthorized`, `session_failed` | connection | none | Connection bar stays; the library retries (401 handled by R-CONN-3) |
| `replaced` | connection | `chat.conn.replaced` | R-CONN-7 |
| `history_unavailable`, `rate_limited`, `offline` | loadOlder | `chat.history.failed` | Retry row (R-HIST-5) |
| `history_disabled` | loadOlder | none | Treat as `end: 'window'` |
| `image_unsupported` | prepare | `chat.error.imageUnsupported` | Refuse |
| `video_too_long` | prepare | `chat.error.videoTooLong` | Refuse |
| `voice_format` | recorder | `chat.error.voiceFormat` | Discard |

---

# 10. Words (keys and English; the app translates)

Wording for the person is in `vircle-chat-app-design.docx` section 7.9; if the two differ, the design document wins. Keys:

| Key | English |
| --- | --- |
| `chat.title` | Customer care |
| `chat.conn.connecting` | Connecting... |
| `chat.conn.offline` | Waiting for network |
| `chat.conn.replaced` | Chat is open on another screen |
| `chat.conn.reconnect` | Reconnect |
| `chat.typing` | Support is typing... |
| `chat.composer.placeholder` | Message |
| `chat.day.today` / `chat.day.yesterday` | Today / Yesterday |
| `chat.newMessages` | New messages |
| `chat.tick.sending` / `sent` / `delivered` / `read` / `failed` | Sending / Sent / Delivered / Read / Not sent |
| `chat.action.retry` / `chat.action.delete` / `chat.action.reply` / `chat.action.cancel` | Retry / Delete / Reply / Cancel |
| `chat.quote.you` / `chat.quote.support` / `chat.quote.photo` | You / Support / Photo |
| `chat.gif` | GIF |
| `chat.attach.document` / `photosVideos` / `camera` / `audio` | Document / Photos & videos / Camera / Audio |
| `chat.voice.hold` / `slideCancel` / `slideLock` / `releaseCancel` | Hold to record / Slide left to cancel / Slide up to lock / Release to cancel |
| `chat.error.tooLong` | Too many characters |
| `chat.error.fileTooBig` | This file is too big (16 MB maximum) |
| `chat.error.fileType` | This type of file cannot be sent |
| `chat.error.videoTooLong` | This video is too long. Trim it to about 30 seconds. |
| `chat.error.queueFull` | Too many unsent messages: check your connection |
| `chat.error.openFile` | Could not open this file |
| `chat.error.imageUnsupported` | This picture cannot be sent |
| `chat.error.voiceFormat` | Could not record a voice note |
| `chat.error.generic` | Something went wrong. Try again. |
| `chat.media.saveGallery` | Save to gallery |
| `chat.media.saved` | Saved to your gallery |
| `chat.history.loading` | Loading earlier messages... |
| `chat.history.failed` | Could not load earlier messages. Tap to try again |
| `chat.history.window` | Earlier messages are not shown |
| `chat.menu.clear` | Clear chat |
| `chat.clear.title` | Clear this chat? |
| `chat.clear.body` | This removes the messages and files from this phone only. Support keeps the conversation. Messages from before now will not be shown again on this phone. |
| `chat.clear.confirm` | Clear chat |
| `chat.a11y.bubbleSupport` | Support, {time}, {text} |
| `chat.a11y.bubbleMine` | You, {time}, {status}, {text} |
| `chat.perm.camera` / `microphone` / `photos` / `photosAdd` | The four system permission texts (design document 7.9) |
| `chat.perm.openSettings` | Open settings |

---

# 11. Platform configuration

| Platform | Settings |
| --- | --- |
| iOS | `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`, `NSPhotoLibraryUsageDescription`, `NSPhotoLibraryAddUsageDescription` (texts in 7.9, translated); Associated Domains `applinks:app.vircle.com` (chat deep links are universal links); URL type scheme `vircle` (older links); push capability as the app already has; App Transport Security stays on |
| Android | `CAMERA`, `RECORD_AUDIO`, `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO` (13+) or the photo picker, `POST_NOTIFICATIONS` (13+); `WRITE_EXTERNAL_STORAGE` only on Android 9 and older for Save to gallery; App Link intent filter (`autoVerify`) for `https://app.vircle.com/chat/`; cleartext traffic off |
| Huawei | The same as Android; push through Huawei Push Kit; test on a device with no Google services |
| WebView CSP | `connect-src` `https://chat.vircle.tech wss://chat.vircle.tech`; `img-src` and `media-src` the same host plus `blob:` `data:` and the origin Capacitor serves cached files from |

---

# 12. Tasks (do them in this order)

Each task: **Goal**, **Depends**, **Do**, **Accept** (all must be true), **Tests**. Commit per task.

**T00 Setup, harness, guard rails.** Depends: none.
Do: install the library tgz; create the layout (3.1) and `ports.ts`; add test doubles for every port (`SqlPort` over `better-sqlite3`); add the
simulator harness (section 13); add a dependency-rule check (a test that fails if anything under `engine/` imports `@capacitor`, `@angular`,
`react`, `vue` or `@ionic`); add `DevSimulatorSessionPort` behind a build flag.
Accept: (1) `npm test` runs and passes with the dependency-rule test; (2) the harness self-test from section 13.2 passes against the local
simulator; (3) a production build contains neither `DevSimulatorSessionPort` nor the string `/simulator/api` (assert in a build test).

**T01 Platform adapters (skeleton).** Depends: T00.
Do: adapters for `DeviceIdPort` (secure storage, UUID created once), `KeyValuePort` (Preferences), `LifecyclePort` (App plugin), `ClockPort`,
`LoggerPort`, `BadgePort`, `SessionPort` (the app's HTTP client to `POST /chat/session`, throws `SessionAuthError` on 401/403).
Accept: each adapter has a test against a mocked plugin; the device id is identical across two `get()` calls and across app restarts (mock
storage); the logger drops any field not a number, boolean or short code string.

**T02 Engine core.** Depends: T00, T01.
Do: `createChatEngine`, `start`, `signOut` (stub wipe calling the pieces built later), `subscribe/getState`, library wiring, `PurgingStore`,
R-CONN-1..8 including 401 handling and screen-visibility rule.
Accept: with the simulator: start -> `online`; send a text -> `sent` or later; agent replies -> appears; kill the socket -> reconnects; a `SessionPort`
that throws `SessionAuthError` stops the library and sets `authRequired` with **no further session calls** (count them); `getSession` is called once
per connection (spy); `setScreenOpen` is true only when visible and foreground (table-driven test of the 4 combinations).

**T03 Rows and emoji-only.** Depends: T02.
Do: `timeline.ts`, `rows.ts`, `emoji-only.ts` exactly per 8.1 to 8.3.
Accept: unit tests: duplicates removed by key; marker filter keeps pending; a day divider exactly when the calendar date changes in the zone, including across
daylight-saving changes and the date line (zones `Pacific/Auckland`, `America/New_York`, `Pacific/Kiritimati`), and `previousDayKey('2026-03-01')` is `'2026-02-28'`; runs break at 5 min, at sender change, at day change; the emoji-only cases listed in 8.3 all pass.

**T04 Message copy (SQLite).** Depends: T02, T03.
Do: schema and migrations (7.1), `message-cache.ts` (`upsert`, `olderThan`, `maxSentAt`, `purgeUpTo`, `count`), batching (7.2), reconcile at start.
Accept: against real SQLite (better-sqlite3): upsert is idempotent; status updates apply; `olderThan` matches the SQL in 8.4 including ties on
`sent_at`; nothing with a URL is stored (assert the `media` JSON has no `url`/`expiresAt`); `sending`/`failed` never stored; 5,000 rows page in under
50 ms per page; the schema runs twice without error; a database without `schema_version` migrates.

**T05 Chat page shell.** Depends: T02, T03.
Do: header ("Customer care" + connection bar), the list (virtualised), the composer's text field and Send, initial spinner, typing line, safe areas,
stick-to-bottom and the New-messages pill (R-LIST-3, R-LIST-4).
Accept: component tests: bar text per state; spinner only while `initialLoading`; with 500 messages only a window of rows is in the DOM; arriving
message at the bottom scrolls, arriving while scrolled up shows the pill with a count and does not move; keyboard-open keeps the last row visible
(simulate by changing the scroller height). Compare against `screens/01-conversation.png` for structure.

**T06 Bubbles.** Depends: T05.
Do: text bubble, sender name, quote block, ticks with text alternatives, day divider, emoji-only large, the a11y labels (R-A11Y-1), long-press
menu with **Reply** (and **Copy text** as the only extra).
Accept: render tests for every row of the table in 6.3 that needs no media; each status shows the right tick and label; the quote shows "You" or
"Support" and a one-line preview with a file-kind word for captionless files; a11y string for a support and a mine message; **Retry** and **Delete**
call `retry`/`discard`.

**T07 Composer.** Depends: T05, T06.
Do: R-COMP-1..7: growing field, Send/mic toggle, counter, typing throttle call, reply bar with swipe-to-reply, draft persistence, optimistic clear.
Accept: tests: whitespace-only disables Send; at 3,600 characters the counter shows; 4,001 cannot send and the text is restored on a mocked
`message_too_long`; typing events call `engine.typing()` on each input; swipe 64 px sets the reply bar, 63 px does not; a message with no `serverId`
cannot be quoted; draft survives unmount/remount and is gone after send.

**T08 Attach menu and pickers.** Depends: T07.
Do: R-ATT-1..5 with `MediaPickerPort` adapters (Capacitor Camera for photos; the video capture route per R-ATT-4; file pickers), permission flows,
preview screen with caption and per-file send.
Accept: order of entries is exactly Document, Photos & videos, Camera, Audio; a `blocked` permission shows the Open-settings dialog; caption longer
than `captionMax` cannot be sent; three picked files send three messages in order, each with its own caption; cancelling sends nothing.

**T09 Preparing photos and videos.** Depends: T08.
Do: `prepare-image.ts`, `prepare-media.ts` per 6.6 with `ImageConvertPort` and `VideoTranscodePort` adapters and a progress bar with cancel.
Accept: a 4,000x3,000 JPEG with EXIF GPS becomes a JPEG with longest side 1,600, no APP1 (EXIF) marker bytes, quality visibly lower size; a PNG with
transparency gets a white background; EXIF orientation 6 comes out upright; HEIC falls back to `ImageConvertPort`, and its failure gives
`image_unsupported`; a 5 MB MP4 passes untouched, a 20 MB MOV is transcoded (mock) and a result over 16 MB gives `video_too_long`; `.gif`, `.zip`, `.svg`
are refused with the file-type message.

**T10 Showing media.** Depends: T06, T09.
Do: image, video, GIF, audio player and document chip bubbles, the viewer, `getMediaSource` (8.5), R-MEDIA-1, 3, 5, 7.
Accept: an image bubble loads from the file cache when present (no `getMediaUrl` call, spy), otherwise asks once; a 410 triggers exactly one refresh;
the GIF element is `<video autoplay loop muted playsinline>` with no `controls` attribute and a GIF tag; the audio length shows `0:12` for 12 s;
the viewer traps focus and closes on Escape/back/swipe-down; tapping a document calls `ShareOpenPort.open`. With the simulator: an agent photo
(`SimAgent.sendFile`) renders as an image bubble with its caption.

**T11 Media cache.** Depends: T04, T10.
Do: `media-cache.ts` (8.6), cache-on-first-show rules (R-MEDIA-2, R-MEDIA-4), background downloads (one at a time, offline-safe).
Accept: adding files past 200 MB evicts least recently used first and never the one just added; a file bigger than the cap is not cached; a missing
file's row is removed on `get`; images/voice notes/GIFs cache on first show, videos/documents only on open (`intent:'open'`); a sent photo is cached
when its `serverId` appears; Clear chat empties both table and directory (T17).

**T12 Voice notes.** Depends: T07, T08.
Do: `voice.ts` reducer, `RecorderPort` adapter (native AAC), UI with timer, slide-left cancel, slide-up lock, 5-minute stop; R-VOICE-1..4.
Accept: reducer tests cover every row of the table in 8.7 including: release at 999 ms discards, at 1,000 ms sends; 300 s auto-send; background
cancels; a recorder returning `audio/webm` is discarded with `voiceFormat` and nothing is sent; a started recording stops a playing note; with a fake
recorder the sent message has `kind: 'audio'` and `durationSeconds` set.

**T13 Emoji picker.** Depends: T07.
Do: R-EMO-1..3 on `emoji/emoji.js`.
Accept: search "heart" finds hearts; tapping inserts at the cursor (not the end) and the panel stays open; recents keep the last 30 per person and
survive restart; skin-tone and flag emoji sent through `sendText` arrive identical (simulator round trip with `SimAgent.messages`); the panel
replaces the keyboard and the list keeps the last row visible.

**T14 Save to gallery and sharing.** Depends: T10, T11.
Do: R-MEDIA-6 with `GalleryPort` and `ShareOpenPort` adapters; viewer action; permission flow.
Accept: nothing is ever saved without a tap (spy on `GalleryPort`: zero calls during a full scripted session); tap on an image calls `saveImage` once
with the cached bytes and shows the confirmation; a voice note and a document do **not** offer Save to gallery; permission `blocked` shows the
settings dialog; Clear chat and sign-out do not call any gallery method.

**T15 Errors, retry, queue.** Depends: T06, T07.
Do: `errors.ts` per section 9, failed-message row actions, `queue_full` blocking, `replaced` banner and Reconnect.
Accept: table-driven test over every code in section 9; a failed upload shows `failed`, **Retry** re-sends once and the message ends `sent`
(simulator with `interceptSend` or by stopping the sim); 50 queued unsent messages produce `queue_full` on the 51st; `replaced` shows the banner and
Reconnect calls `reconnectNow`.

**T16 Badge, foreground/background, deep link, push.** Depends: T02.
Do: R-BADGE-1, R-PUSH-1, R-PUSH-2, R-CONN-4..6 wiring; `PushRoutingPort` (`isChatAlert` is `data.chat_alert === '1'`).
Accept: tests: foreground event reconnects; background sets the badge to the unread count and foreground screen-visible sets it to 0; chat alert while
the chat page is visible shows nothing; deep link navigates and calls `reconnectNow`; a non-chat URL returns false. Keep the payload contract in one place (the port) and mark `TODO(push-team)`
only for the push API passing the fields through, which the push team has still to confirm.

**T17 Clear chat and sign-out.** Depends: T04, T11.
Do: 8.8 and R-CLEAR-1..2, R-SIGNOUT-1..2, overflow menu and confirm dialog.
Accept: with 200 messages and 30 cached files: after `clearChat` the tables and the directory are empty, the library's kept state has no cleared
message, pending messages survive, `rows` is empty and, after one `loadOlder()`, `history.end` is `'cleared'`, a new agent message shows afterwards; **restart** (new engine,
same storage) shows nothing from before; a replay of old messages from the gateway after `lastSeq` loss stays hidden by the marker; a clock-ahead
phone does not hide new messages (use `ClockPort` fake +1 day). `signOut` leaves **no** database, no files, no `vircle-chat:<wallet>:` keys (assert
with the fakes), keeps the device id, calls `chat.clearLocal` once, and a second sign-in as another wallet shows none of the first person's messages.
Neither path calls `GalleryPort`.

**T18 Older history from the phone's copy (Phase A).** Depends: T04, T05, T17.
Do: `history.ts` per 8.4 steps 1 and the Phase A branch, the screen's scroll trigger (R-HIST-2), spinner row, retry row, keep-position (8.9), end markers.
Accept: with 400 stored messages the engine pages 30 at a time newest first with no duplicates and no gaps (assert the union equals the stored set);
a failing cache read shows the retry row and one tap retries once (no loop); prepending 30 rows moves the anchor row by under 1 px; scrolling while
`loading` issues no second request; with a marker set, nothing older than it appears; in Phase A with the copy exhausted, `canLoadMore` is false and
**no end claim is shown** (no "Start of conversation").

**T19 Older history from Halo (Phase B).** Depends: T18, library 1.1.0.
Do: use `fetchHistory` per 5.4 and 8.4 step 2; write fetched pages into the copy; end markers `start` and `window`; error mapping.
Accept (against the Halo team's updated simulator): a page of 30 arrives; `more:false` with `end:'window'` shows "Earlier messages are not shown";
`end:'start'` shows no extra text; `history_unavailable` shows the retry row; fetched messages are cached and later pages come from the phone with no
request (spy); fetched messages are not counted unread and send no receipts; `media.url` is not stored. If library 1.1.0 is not available yet, this
task is **blocked: say so and stop here**; do not fake it.

**T20 Polish: i18n, accessibility, themes, text size.** Depends: T05..T19.
Do: R-A11Y-*, R-THEME-1, R-I18N-1; every visible string through keys; bubbles on theme tokens; dynamic type.
Accept: a test that fails if any component contains a hard-coded user-visible literal (lint rule or scan); both themes render with bubble contrast at
least 4.5:1 (computed from the tokens); at the largest text size nothing is clipped (snapshot at 200%); a screen-reader pass checklist file is filled in.

**T21 Device test pass.** Depends: all.
Do: run the 24-row test plan of the design document (14.1) on the device list (14.2); record results in `chat-device-test-report.md` (row, device, result,
note). Fix what fails.
Accept: every row passes on every device, or is listed with a reason and an owner. Needs a person with the devices.

**T22 Hand-in.** Depends: T21.
Accept: section 14 checklist is all ticked, with evidence links.

---

# 13. Testing

## 13.1 The local gateway and the scripted support agent (no person needed)

Start (from the kit's `simulator/` folder, Node 24.22.1 or later (22.23.4 or later also works)):

```bash
npm install
npm run sim            # gateway on http://localhost:8090, fake Halo on 8091, no database to install
```

`scripts/sim-agent.mjs` lets a test play **Halo's agent**:

```js
import { SimAgent } from './scripts/sim-agent.mjs'
const agent = await new SimAgent('http://localhost:8090').login()
const user = await agent.createUser({ name: 'Aisha' })                 // wallet id sim_xxxxxxxx
const getSession = agent.sessionFor(user.wallet_id)                    // gives { token, wsPath } like the backend would
await agent.say(user.wallet_id, 'Hello')                               // support text; { replyToServerId } to quote
await agent.sendFile(user.wallet_id, bytes, { contentType: 'image/png', fileName: 'a.png', caption: 'a picture' })
await agent.typing(user.wallet_id)                                     // "Support is typing..."
await agent.read(user.wallet_id)                                       // the user's messages become read
const { messages } = await agent.messages(user.wallet_id)              // the conversation as Halo sees it, with each message's status
```

## 13.2 Self-test of the harness

```bash
node scripts/sim-agent-selftest.mjs     # needs the simulator running; prints PASS/FAIL per check
```

It runs the real library in Node (with the `ws` package) against the simulator. **Copy its shape** for your engine's integration tests:
construct the engine with real library + fake ports + `getSession` from `agent.sessionFor`, drive the engine, assert on `engine.getState()`.

## 13.3 `DevSimulatorSessionPort`

Development builds only. It performs `SimAgent.login` + `createUser` once and answers `createSession()` with `agent.sessionFor(...)`. Gate it with a
compile-time flag so it cannot reach a production bundle (T00 criterion 3). It stands in for the backend endpoint that does not exist yet.

## 13.4 Levels

| Level | Tool | What |
| --- | --- | --- |
| Unit | Vitest (or the app's runner) | pure modules with fake ports: timeline, rows, emoji-only, voice reducer, cache SQL, LRU, errors |
| Integration | Vitest + real library + simulator + `SimAgent` | connection, send/receive, ticks, photo round trip, reconnect, clear/restart |
| Component | the framework's testing library | list, bubbles, composer, pickers, viewer, emoji panel |
| Device | a person with phones | design document 14.1 (24 rows) and 14.2 (device list) |

Run unit and component tests on every commit; integration tests need the simulator started by the test setup (spawn `npm run sim`, wait for `/readyz`).

---

# 14. Hand-in checklist

- [ ] Every acceptance criterion in T00 to T20 demonstrably true (tests green, in CI or one command).
- [ ] `engine/` has no framework or Capacitor imports (test passes).
- [ ] No secret, token, message text, phone number or e-mail in code, logs, fixtures or screenshots.
- [ ] Production build contains no simulator code (T00).
- [ ] Zero gallery writes in a full scripted session without a Save tap (T14).
- [ ] Clear chat and sign-out leave nothing behind (T17), the gallery untouched.
- [ ] Photos are JPEG, at most 1,600 px, no EXIF (T09).
- [ ] The 200 MB cache never exceeds its cap in a long scripted run (T11).
- [ ] All visible words come from i18n keys; English supplied; both themes and the largest text size checked (T20).
- [ ] The 24-row device test report is filled in (T21), or each gap has a reason and an owner.
- [ ] Phase B (T19) done, or explicitly marked blocked on library 1.1.0.
- [ ] A short `README` in `src/chat/` explains the layout, how to run the simulator and the tests, and what is still open.

---

# 15. When this document is silent

## 15.1 Defaults

| Question | Default |
| --- | --- |
| UI framework | The one the app already uses. If the chat module is the first screen of a kind, follow the nearest existing screen's conventions |
| Colours, fonts, icons, spacing | The app's theme tokens. Do not invent a palette |
| Time format | The device's 12/24 hour setting via `Intl` |
| Haptics | A light tap on starting a voice recording and on lock; nothing else |
| Sounds | None |
| Message long-press menu | **Reply** and **Copy text** only |
| Page size | 30 |
| Hydrate at start | The newest 50 rows from the copy |
| Retries of history | None automatic |
| Encryption at rest | Off until Security decides; adapter-level when on |
| Certificate pinning | Off until Security decides |

## 15.2 Stop and ask the engineer when

- the host app has more than one UI framework and the chat module's home is unclear;
- a task needs a plugin that is not already in the app and has no obvious standard choice (SQLite, native recorder, video transcoder): propose two
  options with their trade-offs, do not pick silently;
- the push payload shape is needed to complete T16;
- you cannot satisfy an acceptance criterion without changing the library (report it to the Halo team with a failing test);
- two documents disagree and 0.2 does not settle it.

---

# Appendix A: the library's surface (the only API there is)

Package `@vircle/chat-client` (ES module, no dependencies). Exports: `VircleChatClient`, `ChatError`, `ALLOWED_MIME_TYPES`, `backoffDelay`,
`DEFAULT_BACKOFF`, `kindOfMime`, `localStorageStore`, `memoryStore`, and the types below.

```ts
class VircleChatClient {
  constructor(opts: ClientOptions)
  start(): Promise<void>                  // loads the kept state, shows it, then connects
  stop(): void                            // closes the socket and stops reconnecting
  reconnectNow(): void
  getSnapshot(): ChatSnapshot             // immutable; a new object on every change
  subscribe(fn: () => void): () => void
  on(event: 'state'|'message'|'typing'|'error'|'wire'|'loaded', fn): () => void
  sendText(text: string, opts?: { replyTo?: string | ChatMessage }): Promise<ChatMessage>
  sendFile(file: { blob: Blob; name?: string | null; type?: string }, opts?: { caption?: string; replyTo?: string | ChatMessage; durationSeconds?: number; animated?: boolean }): Promise<ChatMessage>
  sendGif(...): Promise<ChatMessage>      // not used by the Vircle app
  retry(id: string): Promise<ChatMessage>
  discard(id: string): void
  setScreenOpen(open: boolean): void
  typing(): void                          // at most one frame every 2.5 s
  getMediaUrl(id: string): Promise<string>
  clearLocal(): Promise<void>             // sign-out: forget everything kept (also resets lastSeq)
}
interface ClientOptions { getSession(): Promise<Session>; deviceId: string; appVersion?: string; baseUrl?: string; store?: ChatStore;
  backoff?: Partial<{ minMs: number; maxMs: number; factor: number; jitter: number }>; autoAcknowledge?: boolean; listenToEnvironment?: boolean;
  pongTimeoutMs?: number; requestTimeoutMs?: number; WebSocket?: ...; fetch?: typeof fetch; interceptSend?: ...; now?: () => number }
interface Session { token: string; url?: string; wsPath?: string }
interface ChatStore { load(): Promise<StoredState | null>; save(state: StoredState): Promise<void>; clear(): Promise<void> }
type MessageKind = 'text' | 'image' | 'video' | 'audio' | 'document'
type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
type ConnectionState = 'idle' | 'connecting' | 'online' | 'offline' | 'replaced' | 'stopped'
interface ChatMessage { id: string; serverId: string | null; seq: number | null; mine: boolean; kind: MessageKind; text: string | null;
  media: ChatMedia | null; replyTo: Quote | null; sender: string | null; sentAt: number; status: MessageStatus; error: ChatErrorInfo | null }
interface ChatMedia { fileId: string | null; url: string | null; expiresAt: number | null; mimeType: string; fileName: string | null; sizeBytes: number; durationSeconds: number | null; animated: boolean }
interface Quote { serverId: string; kind: MessageKind; text: string | null; from: 'you' | 'support' }
interface Limits { textMax: number; captionMax: number; fileMaxBytes: number; sendPerWindow: number; sendWindowSeconds: number }
interface ChatSnapshot { state: ConnectionState; nextAttemptAt: number | null; messages: readonly ChatMessage[]; supportTyping: boolean; loaded: boolean;
  unreadCount: number; limits: Limits | null; conversationId: string | null; lastSeq: number; lastError: ChatErrorInfo | null }
class ChatError extends Error { code: string }
```

Facts about the library the engine relies on:

- It keeps at most **200** messages (and unsent text) in its own `ChatStore`; the engine's SQLite copy exists because of that.
- It treats any `getSession` rejection as a connection problem and retries with growing waits (1 s to 30 s, jittered); it has no notion of 401.
- It reports "delivered" automatically for support's messages and "read" while `setScreenOpen(true)`.
- It queues up to 50 unsent messages (`queue_full` beyond that) and survives reconnects; text written but not yet stored survives an app restart; **files** not yet uploaded do not.
- `getMediaUrl` returns the message's link when it is good for another minute, otherwise asks the gateway for a fresh one (needs a connection).
- Allowed file types and limits: PNG, JPEG, WebP, MP4, 3GPP, audio Ogg/MP3/AAC/MP4/AMR, PDF, Word, Excel, PowerPoint, plain text; **16 MB**; voice notes at most **5 minutes**; text **4,000** characters; caption **1,024**.

# Appendix B: glossary

- **Gateway**: the server the app connects to (`https://chat.vircle.tech`); a relay that keeps delivered messages for 30 days.
- **Halo**: the support system (inbox, AI, tickets); keeps the whole conversation for good and is the history source.
- **Engine**: the framework-free TypeScript layer you build around the library.
- **The phone's copy / the cache**: the engine's SQLite database and file cache.
- **Marker (cleared-before)**: the time of the newest message that was cleared; nothing at or before it is shown or fetched again.
- **Simulator**: a pretend phone and agent console on the same library; `npm run sim` runs it locally.
- **Phase A / B**: before / after library 1.1.0 (`fetchHistory`) exists.
