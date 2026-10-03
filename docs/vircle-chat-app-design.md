---
title: "Vircle Chat in the Vircle app: design document for the mobile front-end"
subtitle: "Ionic / Capacitor build guide, keys and credentials, screens, attachments, emoji, GIFs, push, testing"
author: "Vircle Halo team"
date: "3 October 2026 (version 1.0)"
---

# 1. Read this first

**Who this is for.** The front-end mobile engineer who builds the customer-care **Chat module** inside the Vircle hybrid app
(Ionic, three builds: Apple, Android, Huawei). It tells you what to build, what you are given, what you must ask the backend
developer for, which keys exist, where each one is generated, and how to test it.

**What you do not have to build.** The connection, reconnecting, resuming after a break, queueing messages while offline, sending
files, delivery and read ticks, typing signals, the local copy of the conversation and the unread count are all done by a ready,
tested library (`@vircle/chat-client`, about 1,100 lines, no dependencies). **You build the screen around it**, plus the
device-specific parts a library cannot do: picking photos, recording a voice note, showing an emoji picker, and handling a push
notification.

**What is decided and what is not.**

| Item | State |
| --- | --- |
| Gateway (the server the app connects to) | Built and live at `https://chat.vircle.tech`. Owned by the Halo team |
| Client library | Built and tested. Delivered with this document as `vircle-chat-client-1.0.0.tgz` |
| Reference screen | The **simulator** (section 14) is a working pretend phone built on the same library: emoji picker, attach menu, GIFs, replies, ticks |
| Session endpoint on the Vircle backend | **Not built.** Backend developer. Ten lines, example in section 5 |
| Push notifications | **On hold** until the Vircle push API details are provided. The gateway already decides when to alert; section 11 says what the app must be ready for |
| GIFs | **No picker and no GIF service in version 1.** The app only has to show a GIF when one arrives (section 10) |

**The chat feels like WhatsApp and the web chat widget.** Section 2 is the feature list you are building to, with what is and is
not included.

# 2. What you are building: feature list

Everything marked **Yes** works end to end today (gateway, Halo and library) and is covered by automated tests. "Library" means you
call one method; "You" means you build it with an Ionic or Capacitor plugin.

| Feature | WhatsApp | Web chat widget | Vircle app | Who builds it |
| --- | --- | --- | --- | --- |
| Text messages (up to 4,000 characters) | Yes | Yes | **Yes** | Library: `sendText` |
| Emoji: keyboard | Yes | Yes | **Yes** | Nothing (the system keyboard). Emoji survive both ways unchanged (tested: skin tones, families, flags, keycaps) |
| Emoji: in-app picker with search | Yes | Yes | **Yes** | You (section 9) |
| **GIFs** | Yes | No | **Shown when one arrives** | You draw it as a looping picture (section 10). No GIF picker and no GIF service key |
| Photos | Yes | Yes | **Yes** | You pick and shrink; library: `sendFile` |
| Videos (up to 16 MB) | Yes | Yes | **Yes** | You pick and compress; library: `sendFile` |
| Documents (PDF, Word, Excel, PowerPoint, text) | Yes | Yes | **Yes** | You pick; library: `sendFile` |
| Audio files | Yes | recorder only | **Yes** | You pick; library: `sendFile` |
| Camera (take a photo or video now) | Yes | phone browser | **Yes** | You (Capacitor Camera / file picker) |
| **Attachment menu** ("+", pops up the choices) | Yes | Yes | **Yes** | You (section 8) |
| Voice notes (hold to record, up to 5 minutes) | Yes | Yes | **Yes** | You record; library sends with its length |
| Captions on photos, videos and documents | Yes | Yes | **Yes** | Library |
| Reply to a message (quote), both ways | Yes | Not yet | **Yes** | You (swipe to reply); library carries the quote |
| Typing indicator, both ways | Yes | Not yet | **Yes** | Library signals; you draw "typing..." |
| Sent, delivered, read ticks | Yes | Yes | **Yes** | Library state; you draw the ticks |
| Works offline, sends when back | Yes | Yes | **Yes** | Library |
| Unread badge | Yes | n/a | **Yes** | Library: `unreadCount`; you show the badge |
| Alert when the app is closed | Push | Email | **Push (on hold)** | Gateway decides; you handle the tap (section 11) |
| Stickers, Location, Contact card, Poll | Yes | No | **No** | Not in version 1 (nor on the widget) |
| Message reactions, edit, delete, forward | Yes | No | **No** | Not in version 1 |
| Link previews | Yes | No | **No** | Not in version 1 |

If something in the second half of that table is wanted, it is a product decision plus work on Halo and the gateway, not only the app.

# 3. How it fits together

```
                  Vircle app (you)                       Vircle backend (its developer)
                  ----------------                       ------------------------------
   chat screen -> @vircle/chat-client  --(1) POST /chat/session -->  your endpoint
                         |                                              |
                         |                       (2) POST https://chat.vircle.tech/v1/sessions
                         |                            Authorization: Bearer <SESSIONS KEY>
                         |                                              |
                         |<-------- (3) { token, ws_path }  -------------
                         |
                         +--(4) wss://chat.vircle.tech/ws   hello { token, device_id, last_seq }
                         |             |
                         |             v
                         |        GATEWAY (chat.vircle.tech)  <== signed events ==>  HALO
                         |             |                                        (agents' inbox,
                         |             +-- app closed? --> Vircle PUSH API       AI, tickets)
                         |                                  (phone or email)
                         +<-- push notification tap -- (5) vircle://chat/{conversation_id}
```

1. When the chat opens, the library calls **your** function `getSession()`. You call the Vircle backend.
2. The backend knows who is signed in. It asks the gateway for a **one-time connect token** for that person, using the **sessions
   key**. The token works once, for about a minute.
3. The backend hands the token to the app. **The app never holds a secret.**
4. The library opens the WebSocket with that token and says which device it is and the highest message number it already holds. The
   gateway sends what it missed.
5. If the app is closed when support replies, the gateway asks the Vircle push API to alert the person (by phone number or email).
   Tapping the alert opens the chat.

**Rules the gateway follows, so you can rely on them.**

- A message from support goes to the open connection if there is one. If the app does not confirm it within 5 seconds, or there is no
  connection, the gateway raises **one** alert per "away period" (a reminder after 24 hours if the person still has not come back).
  Messages are never lost: opening the chat shows everything.
- Every send carries an id you cannot see (the library makes it), so a message sent twice because the network dropped is stored once.
- The conversation is **one per person**, kept by the gateway for 30 days after delivery (Halo keeps it for good). A fresh install
  shows the history the gateway still holds.
- One person may have up to **3 devices** connected; a new one beyond that replaces the oldest, which then shows `replaced`.

# 4. Keys, secrets and where each one comes from

**You need almost none.** This section exists so nobody pastes a secret into the app. There are four kinds of value, and only the
last two concern your code.

## 4.1 What Halo generates (Settings, Channels, Vircle Chat)

This is done once per Halo workspace by whoever administers Halo, **not** by you.

| Value | Looks like | Generated | Who holds it | Used for |
| --- | --- | --- | --- | --- |
| Workspace key | `vcw_...` | Halo, when the channel is saved | Halo and the gateway | Names the workspace in every event. Not secret |
| Webhook URL | `https://crm.vircle.tech/api/vircle-chat/webhook` | Halo (shown on the same screen) | Gateway | Where the gateway posts events to Halo |
| **Signing secret** | `vcs_...` | Halo. **Shown once** | Halo (encrypted) and the gateway (encrypted) | The gateway signs every event to Halo with it |
| **API token** | `vct_...` | Halo. **Shown once** | Halo (encrypted) and the gateway (hashed) | Halo calls the gateway with it |

**Where in Halo:** sign in as an Owner or Admin, open **Settings, Channels, Vircle Chat**, type the gateway address
`https://chat.vircle.tech`, press **Save and connect**. The screen shows the four values; the two secrets are never shown again
(a **Rotate** button makes new ones). Press **Test connection** to confirm. The channel must first be switched on for the workspace
by a platform operator (Platform console, Modules, Vircle Chat). The administrator then registers the workspace on the gateway
with the command in `docs/vircle-chat-gateway-deploy.md` (section 5). **None of these four values go into the app.**

## 4.2 What the gateway generates

When the workspace is registered on the gateway, it prints a **sessions key**. It is what lets the **backend** ask for a chat session
for a signed-in person.

| Value | Generated | Held by | Used for |
| --- | --- | --- | --- |
| **Sessions key** | The gateway, when the workspace is registered (`create-workspace`), and again by `rotate-sessions-key` | **The Vircle backend only** (its secret store). Never the app, never source control | `Authorization: Bearer <key>` on `POST /v1/sessions` |

The administrator gives it to the backend developer once, over a safe channel. If it is ever exposed (for example pasted into a chat
or an email), it is rotated and the backend is given the new one.

## 4.3 What you configure in the app (not secret)

| Setting | Value | Notes |
| --- | --- | --- |
| Gateway address | `https://chat.vircle.tech` | Same for all builds. A different address only if a separate gateway is ever stood up |
| Session endpoint | the backend's address, for example `https://api.vircle.tech/chat/session` | Built by the backend developer; section 5 |
| Device id | a random id made on first launch, kept in secure storage | One per install. Same value forever: it is how the gateway recognises "the same device reconnecting" |
| Deep link | `vircle://chat/{conversation_id}` | The scheme your app registers; section 11 |

## 4.4 Test and live environments

Use **two Halo workspaces**, each with its own keys: the live one, and a **sandbox** one for development and testing. A platform
operator creates the sandbox workspace in the Platform console and switches Vircle Chat on for it; the administrator then runs
sections 4.1 and 4.2 for it, which gives a **sandbox sessions key** for the backend's test environment. The same gateway serves both:
the sessions key decides which workspace a person's chat belongs to. Your build flavours then differ only in the **session endpoint**
(test backend or live backend). In the sandbox, messages appear in the sandbox Halo's inbox, where a tester plays the agent.

# 5. The one piece the backend must build: the session endpoint

The library calls a function **you** pass in (`getSession`) before **every** connection (the token works once). That function calls
your backend, which calls the gateway.

**Backend (Node/Express shown; any language works):**

```js
app.post('/chat/session', requireSignedInUser, async (req, res) => {
  const r = await fetch('https://chat.vircle.tech/v1/sessions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.VIRCLE_CHAT_SESSIONS_KEY}`,   // the sessions key, from the secret store
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      user: { wallet_id: req.user.walletId, name: req.user.name, phone: req.user.phone, email: req.user.email },
    }),
  })
  if (!r.ok) return res.status(502).json({ error: 'chat unavailable' })
  const { token, ws_path } = await r.json()      // the token works once, for about a minute
  res.json({ token, wsPath: ws_path })
})
```

Rules for the backend developer:

- The **identity comes from the signed-in session, never from the app's request body**. `wallet_id` is the person's identity in Halo
  (it links the chat to their WhatsApp or email history). Send `phone` and `email` whenever known: when the app is closed the gateway
  uses them to find the person in the push API.
- The call must be made per connection; do not cache the token.
- Answer 401 when nobody is signed in; the library then stops trying and reports `lastError`.

**App:** `getSession: () => http.post('/chat/session')` returning `{ token, wsPath }`, with your normal auth header attached by your
HTTP interceptor.

# 6. Installing the library

The library is delivered as a package file, `vircle-chat-client-1.0.0.tgz` (about 40 KB: ES module, TypeScript types, a README).

```bash
npm install ./vendor/vircle-chat-client-1.0.0.tgz
```

Keep the file in the app repository (for example `vendor/`) so builds are repeatable. A new version is delivered the same way; version 1
speaks protocol version 1, and a protocol change will be announced with a new major version. Works in Capacitor and Cordova (it
listens to `online`, `visibilitychange` and `resume`), in any framework, and in a plain browser. Requirements: a WebView with
WebSocket, `fetch`, `Blob` and `Promise` (every current iOS, Android and Huawei WebView).

The library's own README (`README.md` inside the package) is the API reference. This document tells you how to use it in the app.

# 7. The chat screen

## 7.1 Structure (Ionic)

```
ion-header        title "Customer care", connection bar (only when not online)
ion-content       the message list (scrolls; stays at the bottom for new messages)
  typing indicator "Support is typing..."   (snapshot.supportTyping)
ion-footer        reply bar (when replying)  |  composer
composer          [emoji]  [text field, grows to 5 lines]  [+ attach]  [mic  or  send]
overlays          attach menu (ion-action-sheet or popover), emoji picker (ion-modal, bottom sheet),
                  media viewer (ion-modal, full screen), voice recorder (inline in the composer)
```

## 7.2 One service owns the client

Make a singleton service so the connection lives as long as the app is signed in, not as long as the screen is open. The chat
screen only reads from it. Angular shown; React and Vue are the same idea (section 7.3).

```ts
// chat.service.ts
import { Injectable, signal } from '@angular/core'
import { App } from '@capacitor/app'
import { VircleChatClient, type ChatSnapshot, type ChatStore } from '@vircle/chat-client'
import { Preferences } from '@capacitor/preferences'
import { environment } from '../environments/environment'

/** Keeps the conversation on the device. Use encrypted storage if your policy needs it (section 13). */
function chatStore(walletId: string): ChatStore {
  const key = `vircle-chat:${walletId}`               // one key per signed-in person
  return {
    load: async () => { const { value } = await Preferences.get({ key }); return value ? JSON.parse(value) : null },
    save: async (state) => { await Preferences.set({ key, value: JSON.stringify(state) }) },
    clear: async () => { await Preferences.remove({ key }) },
  }
}

@Injectable({ providedIn: 'root' })
export class ChatService {
  readonly snapshot = signal<ChatSnapshot | null>(null)
  private client: VircleChatClient | null = null

  constructor(private session: SessionApi, private device: DeviceIdService) {}

  /** Call after sign-in. */
  async start(walletId: string): Promise<void> {
    this.client = new VircleChatClient({
      baseUrl: environment.chatBaseUrl,                      // https://chat.vircle.tech
      deviceId: await this.device.get(),                    // stable per install
      appVersion: environment.appVersion,
      store: chatStore(walletId),
      getSession: () => this.session.create(),              // calls the backend (section 5)
    })
    this.client.subscribe(() => this.snapshot.set(this.client!.getSnapshot()))
    // The app returns to the foreground: reconnect now instead of waiting for the next retry.
    App.addListener('appStateChange', ({ isActive }) => { if (isActive) this.client?.reconnectNow() })
    await this.client.start()                                // shows the kept conversation at once, then connects
  }

  /** Call on sign-out. */
  async stop(): Promise<void> {
    this.client?.stop()
    await this.client?.clearLocal()                          // forget the conversation on this device
    this.client = null
    this.snapshot.set(null)
  }

  get chat(): VircleChatClient { return this.client! }
}
```

The page then draws `chatService.snapshot()`:

```ts
// chat.page.ts (excerpt)
ionViewWillEnter() { this.chatService.chat.setScreenOpen(true) }     // "read" ticks; unread badge to 0
ionViewWillLeave() { this.chatService.chat.setScreenOpen(false) }
```

## 7.3 React and Vue

```ts
// React: the snapshot is one immutable object, replaced on every change, so this just works
const snap = useSyncExternalStore(chat.subscribe.bind(chat), chat.getSnapshot.bind(chat))
```

In Vue, put `chat.getSnapshot()` in a `shallowRef` and set it inside `chat.subscribe(...)`.

## 7.4 What the snapshot gives you

| Field | Use |
| --- | --- |
| `messages` | The list, in order. Use `id` as the list key (stable) |
| `state` | `online`, `connecting`, `offline` (with `nextAttemptAt`), `replaced`, `idle`, `stopped`. Show a thin bar when not `online` ("Connecting...", "Waiting for network"). **Do not block the screen**: sending still works and is queued |
| `supportTyping` | Show "Support is typing..." |
| `loaded` | Show a spinner only until it is true **and** the list is empty |
| `unreadCount` | The number for the badge on the chat tab or the app icon. 0 while the screen is open |
| `limits` | `textMax` 4,000, `captionMax` 1,024, `fileMaxBytes` 16 MB (known after the first connection; the library enforces them, the UI can show counters) |
| `lastError` | The last problem with the connection itself (for a support screen or a log) |

Each message has `kind` (`text`, `image`, `video`, `audio`, `document`), `text`, `media`
(`url`, `mimeType`, `fileName`, `sizeBytes`, `durationSeconds`, `animated`), `replyTo`
(the quoted message: `kind`, `text`, `from`), `mine`, `sender`, `sentAt` and `status`.

## 7.5 Drawing a message

| Message | Draw |
| --- | --- |
| Mine, `text` | Right-aligned bubble, then time and ticks |
| Support, `text` | Left-aligned bubble with the sender name above on the first of a run |
| `replyTo` set | A small quoted block inside the bubble: sender ("You" or "Support") and a one-line preview; for a quoted photo, the word "Photo" |
| `image` | Thumbnail at most about 240 pt wide; tap opens full screen with pinch to zoom; caption below |
| `video` | Poster frame with a play icon; tap plays full screen with controls; caption below |
| `video` with `media.animated` | **A GIF.** `<video autoplay loop muted playsinline>` with no controls and a small "GIF" tag. Tap may open it larger |
| `audio` | Voice-note player: play and pause, a progress bar, the length from `durationSeconds` (for example 0:12). Playback speed 1x, 1.5x, 2x is a nice extra |
| `document` | A chip with a file-type icon, the file name and the size; tap opens it (section 8.5) |
| Emoji only (up to 3) | Render the emoji larger and without a bubble background, as WhatsApp does (nice to have) |
| Day change | A centred divider ("Today", "Yesterday", the date) |

**Ticks on your own messages** (`status`): `sending` a clock, `sent` one grey tick, `delivered` two grey ticks, `read` two blue
ticks, `failed` a red exclamation with **Retry** and **Delete** (`chat.retry(id)`, `chat.discard(id)`). A status only moves
forward. The ticks reflect Halo: delivered means support's system has it, read means an agent opened the conversation.

**Media links expire** (24 hours). Never store a media URL yourself. To show a message's file, call `await chat.getMediaUrl(message.id)`
just before use; it returns the current link or fetches a fresh one. A message you are still sending shows a local preview until it
is uploaded.

## 7.6 Layout details that decide whether it feels right

- **Stay at the bottom** when a message arrives and the user was already near the bottom; otherwise do not move the list and show a
  "New messages" pill with a down arrow instead.
- **Keyboard:** use `Keyboard` plugin resize mode `native` (iOS) or `body`, and make the list scroll to the bottom when the keyboard
  opens. Put the composer in `ion-footer` so it rides above the keyboard and the safe area.
- **Safe areas:** pad the composer with `env(safe-area-inset-bottom)`; the header with `env(safe-area-inset-top)`.
- **Long conversations:** the library keeps the last 200 messages on the device between launches, and a fresh install loads whatever
  history the gateway still holds (30 days) in batches. Use a virtualised list (`ion-content` with `cdk-virtual-scroll` or
  `@tanstack/virtual`) once lists pass a few hundred rows. Message heights vary, so use dynamic row heights.
- **Dark mode:** use Ionic's colour variables; the bubbles for "mine" and "support" need a contrast pair in both themes.
- **Text size:** respect the system text size (Ionic `dynamic font scaling`).
- **Screen readers:** each bubble reads as "Support, 10:42, message text" or "You, 10:43, delivered"; GIFs read "GIF"; ticks have text
  alternatives.
- **Language:** the app's strings (placeholders, "typing...", tick labels, errors) go through the app's normal translation system.
  The conversation text itself is whatever the person and the agent wrote.

# 8. The attachment menu, photos, videos, documents, camera, audio

## 8.1 Behaviour to build (same as WhatsApp and the web widget)

Tapping the **+** button in the composer opens a menu (Ionic `ion-action-sheet` on phones, or a small `ion-popover` above the button).
Entries, in this order:

| Entry | Opens | Sends as |
| --- | --- | --- |
| **Document** | The system file picker, filtered to PDF, Word, Excel, PowerPoint, plain text | `document` |
| **Photos & videos** | The photo library (multiple selection optional) | `image` or `video` |
| **Camera** | The camera, photo or video | `image` or `video` |
| **Audio** | The system file picker, filtered to audio | `audio` |

A **voice note** is not in the menu: it is the **microphone button** that replaces Send while the text field is empty (section 8.4).
**Not offered:** GIF (the app only shows GIFs, section 10), Location, Contact, Poll (not supported by Halo, nor on the web widget).

After choosing a file, show a **preview with a caption field** and a Send button (as WhatsApp does), then call `sendFile`. The
message appears in the list at once as "sending" with a local preview, so the user never waits.

## 8.2 Sending

```ts
await chat.sendFile({ blob, name: 'receipt.jpg', type: 'image/jpeg' }, { caption: 'my receipt' })
await chat.sendFile({ blob: voice, name: 'note.m4a', type: 'audio/mp4' }, { durationSeconds: 12 })
await chat.sendFile({ blob: pdf, name: 'statement.pdf', type: 'application/pdf' })
```

`sendFile` checks the type, the size and the caption length **before** uploading and rejects with a `ChatError` (section 12). Quote a
message with `{ replyTo: message }`. Several files: call it once per file; the library sends them in order.

## 8.3 What is allowed (the same list as WhatsApp and the web widget)

| Kind | Types | Limit |
| --- | --- | --- |
| Photo | PNG, JPEG, WebP | 16 MB |
| Video | MP4, 3GPP | 16 MB |
| Audio and voice | Ogg, MP3, AAC, MP4 audio, AMR | 16 MB; **voice notes up to 5 minutes** |
| Document | PDF, Word (`.doc`, `.docx`), Excel (`.xls`, `.xlsx`), PowerPoint (`.ppt`, `.pptx`), plain text | 16 MB |

**Not allowed, so convert first:** HEIC/HEIF photos (iPhone gallery default), GIF files, WebM and MOV video, SVG, ZIP, Opus/WebM audio.
The gateway also checks the file's real content, not only the name.

**The app must prepare files; the library does not:**

- **Photos:** shrink before sending. Resize so the longest side is at most 1,600 px and re-encode as JPEG at quality 0.8 (a
  canvas does this in a few lines). That makes a 4 MB photo about 300 KB, and converts HEIC to JPEG. With the Capacitor Camera
  plugin ask for `format: 'jpeg'` (the default) so HEIC never appears.
- **Videos:** phone videos are usually far over 16 MB. Compress and trim before sending (an on-device transcoder plugin, H.264 MP4,
  roughly 720p, 1.5 to 2 Mbps), the way WhatsApp does, and show the user a progress bar. If it is still over 16 MB, tell them
  ("This video is too long. Trim it to about 30 seconds.").
- **Audio files:** only the types above. Voice notes: see below.
- **Permissions:** declare them (section 13.3).

## 8.4 Voice notes

Behaviour: when the text field is empty the **mic** replaces **Send**. **Press and hold** to record (a timer and "slide left to cancel"
appear); release to send; slide up to lock for long notes. Up to **5 minutes**.

**Record in a format the gateway accepts.** The WebView's own `MediaRecorder` produces **WebM/Opus on Android, which is rejected**.
Use a native recorder plugin that produces AAC (for example `capacitor-voice-recorder`, which returns base64 with
`mimeType` `audio/aac` or `audio/mp4` and the duration in milliseconds). Convert the base64 to a `Blob` and send:

```ts
import { VoiceRecorder } from 'capacitor-voice-recorder'

await VoiceRecorder.requestAudioRecordingPermission()
await VoiceRecorder.startRecording()
// ... on release:
const { value } = await VoiceRecorder.stopRecording()      // { recordDataBase64, mimeType, msDuration }
const blob = await (await fetch(`data:${value.mimeType};base64,${value.recordDataBase64}`)).blob()
await chat.sendFile({ blob, name: 'voice-note.m4a', type: value.mimeType.split(';')[0] },
                    { durationSeconds: value.msDuration / 1000 })
```

Check the plugin's current API when you add it; the requirement is only: AAC (or Ogg, MP3, AMR) audio and an accurate duration. If the
recorder cannot report the duration, measure it yourself. Show the sent voice note with a waveform if wanted; the library only
carries the length.

## 8.5 Opening a received document

Tap a document chip, call `chat.getMediaUrl(message.id)`, then open it with the system viewer (`@capacitor/browser` opens it in a
secure browser sheet, which handles PDF and downloads; a file-opener plugin gives "Open in..." for Word and Excel). Do not expect
the URL to work tomorrow: ask again each time.

# 9. Emoji

Emoji are ordinary text; **sending them needs no special code**: the keyboard's emoji work, and the text goes through `sendText`
unchanged. This was tested end to end with the hard cases (skin tones, joined family emoji, flags, keycaps, a heart on fire) in both
directions, including inside a quoted reply. (A message is limited to 4,000 characters counted the way JavaScript counts them, so a
message of only emoji holds about 2,000.)

**Build the in-app picker** (the emoji button left of the text field), because it is part of the WhatsApp feel and the web widget
has one:

- A bottom sheet (`ion-modal` with breakpoints, or an inline panel that replaces the keyboard, as WhatsApp does).
- Tabs for the categories: smileys, people, animals, food, travel, activities, objects, symbols, flags. A **search** box. A **recent**
  tab, remembered on the device.
- Tapping an emoji inserts it **at the cursor** in the text field and keeps the picker open.
- **Data:** do not write your own list. Use either the same list the web widget uses (1,914 emoji, each with search words; the file
  `emoji.js` is delivered with this document, and the simulator's `simulator.js`, function `buildEmoji`, shows how to read it), or a maintained component such as `emoji-picker-element` (a web component that works in a WebView).
- **Rendering:** emoji use the phone's own emoji font. Older Android and some Huawei WebViews lack the newest emoji and show an empty
  box; if that matters for your minimum OS, bundle Noto Color Emoji as a web font.
- **Skin tones** are a nice extra; they are normal emoji sequences, so they send like any text.

**Emoji-only messages** of up to three emoji are shown large without a bubble (a regular expression using
`\p{Extended_Pictographic}` with a quick check that nothing else is in the text).

# 10. GIFs: showing them

**Decision (3 October 2026): the app does not create or search for GIFs.** There is no GIF button, no GIF picker and no GIF service
account or key. What the app must do is **show a GIF properly when one arrives**.

## 10.1 How a GIF arrives

WhatsApp does not send `.gif` files either. It turns a GIF into a short **looping MP4** and marks it, so every screen plays it as a
muted loop. The Vircle chat carries the same marking:

- The message has `kind: 'video'`, `media.mimeType: 'video/mp4'` and **`media.animated: true`**.
- Draw it as `<video autoplay loop muted playsinline>` with **no controls** and a small "GIF" tag; tapping may open it larger. Without
  `muted` and `playsinline`, iPhones will not autoplay it.
- It needs no special handling in the library: it is an ordinary message with a file. Fetch its address with
  `chat.getMediaUrl(message.id)` as for any file.
- Autoplay in the WebView needs `muted` and `playsinline` on the element (as above). If the build is Cordova rather than Capacitor, also
  set the `AllowInlineMediaPlayback` preference to true so iOS plays it inline.
- Also be ready for an ordinary `image` message whose file is a `.gif` or `.webp`: an `<img>` element animates it by itself, so the
  normal photo bubble already shows it.

## 10.2 Who can post a GIF today

- **Support agents in Halo cannot post GIFs yet.** The inbox's attach menu refuses `.gif` files, because it shares the list of types
  WhatsApp accepts. So today **nothing in production produces a GIF for the app to show.** The app should still be ready (above), and the
  simulator's **Agent** tab has a **GIF** button that sends one, so you can build and test the display now.
- If agents should be able to post GIFs (for example to a Vircle Chat or web-widget conversation, not to WhatsApp), that is a small
  change on the Halo side, and it needs a decision (section 16). The app needs nothing more when it ships.
- The library can still send a GIF (`chat.sendGif`) and refuses `.gif` files with the error `gif_must_be_mp4`. The app does not need
  either: do not build a GIF button.

# 11. Push notifications and deep links (on hold, design now)

**State.** The gateway decides when to alert and calls the Vircle push API with the person's phone number or email. That API's
details are not yet agreed, so **real alerts are not sent yet**; the gateway records them. Everything below is what the app must be
ready for, so that nothing changes on your side when push is switched on.

**What the app does** (with Vircle's existing push setup):

1. Register the device for push as the app does today (FCM on Android, APNs on iPhone, Huawei Push Kit on Huawei). **Nothing
   chat-specific is registered**: the push API finds the person by phone or email.
2. **Receive** an alert. Its content, set by the gateway: a title (default: the workspace name), a body (default: "You have a new
   message"; both can be changed per workspace), a **deep link** `vircle://chat/{conversation_id}`, and a **collapse key** (the
   conversation id) so a second alert replaces the first instead of stacking.
3. **Tap** opens the app at the deep link. Register the scheme `vircle://` (iOS URL type; Android intent filter; and Huawei) and
   listen:

```ts
App.addListener('appUrlOpen', ({ url }) => {
  const m = /^vircle:\/\/chat\/([\w-]+)/.exec(url)
  if (m) { this.router.navigateByUrl('/chat'); this.chatService.chat.reconnectNow() }   // the missed messages arrive
})
PushNotifications.addListener('pushNotificationActionPerformed', ({ notification }) => {
  // when the push arrives as a notification payload, route from notification.data as well
})
```

4. **When the chat screen is open, do not show a banner** for a chat alert (the message is already on screen): suppress it in the
   foreground handler. When the app is open on another screen, show the in-app banner or the badge from `unreadCount`.
5. **Badge:** set the app icon badge from `chat.getSnapshot().unreadCount` when the app goes to the background.

**Order of events for a tester:** (a) the user closes the app; (b) an agent replies in Halo; (c) the gateway sees there is no connection
and raises one alert at once (if the app was open but did not confirm the message within 5 seconds, it alerts after that); (d) the user taps it; (e) the app opens on the chat showing the reply. With the mock this is visible in the simulator's **Push
inbox** tab.

**Still needed from the push team** (blocks work package 8, not your screen): the endpoint and authentication, the request fields,
the title and body wording, and the error contract. When agreed, the payload names will be added to this document.

# 12. Errors and what to show

The library's methods reject with a `ChatError` that has a `code` and a plain `message`.

| Code | When | Show |
| --- | --- | --- |
| `message_too_long` | Over 4,000 characters (or a caption over 1,024) | Counter on the field; block send |
| `file_too_large` | Over 16 MB, or a voice note over 5 minutes | "This file is too big (16 MB maximum)" |
| `file_type_not_allowed` | A type outside the list in 8.3 | "This type of file cannot be sent" |
| `bad_request` | Empty message or file | Ignore |
| `rate_limited` (on a message) | More than 30 sends in 10 seconds | The library waits and sends; no message needed |
| `upload_failed`, `network`, `timeout`, `offline` | The network failed during an upload | The message shows `failed`; offer Retry |
| `queue_full` | A very large number of unsent messages | "Too many unsent messages: check your connection" |

A message that fails has `status: 'failed'` and an `error`; show a red mark and **Retry** / **Delete**. Connection problems are not
errors on a message: they show in `snapshot.state` and `snapshot.lastError`.

`replaced` means another connection of the same device id took over (for example two copies of the app after a restore). The library
does not fight for it: show "Chat is open on another screen" and a **Reconnect** button that calls `reconnectNow()`.

# 13. Lifecycle, storage, security, platform settings

## 13.1 Lifecycle

| Event | Do |
| --- | --- |
| Sign in | `chatService.start(walletId)` |
| Chat screen enters or leaves | `setScreenOpen(true)` / `(false)` |
| App returns to the foreground | `reconnectNow()` (the library also reconnects by itself on `online` and `resume`) |
| Network comes back | Nothing: the library reconnects with growing waits (1 s to 30 s) and sends what was queued |
| User taps a push alert | Navigate, then `reconnectNow()` |
| Sign out | `stop()` then `await clearLocal()`; never leave one person's conversation for the next person |
| Account switch | `stop()`, `clearLocal()`, then `start()` with the new wallet id (the store key is per wallet) |
| App killed with unsent messages | Written text is kept and sent at the next launch; files not yet uploaded are not kept: the user sees the message was not sent |

## 13.2 Storage and privacy

The library keeps the last 200 messages (and unsent text) through the `ChatStore` you give it. `localStorage` works but is plain text on
the device. If Vircle's policy requires encryption at rest, implement `ChatStore` on an encrypted store (for example an encrypted
SQLite plugin or the secure-storage plugin), keeping the key per signed-in person. Media files are never stored by the library
(only their short-lived links).

**Never log** tokens, message text or phone numbers. The library does not.

## 13.3 Permissions and platform settings

| Platform | Settings |
| --- | --- |
| iOS | `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`, `NSPhotoLibraryUsageDescription`, `NSPhotoLibraryAddUsageDescription` (text a human can understand, in the app's languages); URL type `vircle`; push capability and background modes if used; App Transport Security stays on (the gateway is HTTPS only) |
| Android | `CAMERA`, `RECORD_AUDIO`; for gallery access `READ_MEDIA_IMAGES` and `READ_MEDIA_VIDEO` (Android 13 and later) or the photo picker; `POST_NOTIFICATIONS` (Android 13 and later); intent filter for `vircle://chat`; cleartext traffic stays off |
| Huawei | The same as Android; push through Huawei Push Kit; test on a device without Google services (the library needs nothing from them) |
| All | Allow `https://chat.vircle.tech` and `wss://chat.vircle.tech` in the WebView's Content Security Policy (`connect-src`), plus `img-src`/`media-src` for the same host (files are served from it) |

## 13.4 Security checklist for review

- No secret in the app or in source control. The sessions key lives only on the backend.
- The session token is requested for every connection and never stored.
- All traffic is TLS (`https`, `wss`); consider certificate pinning to `chat.vircle.tech` if Vircle's other APIs do.
- The conversation is cleared from the device on sign-out.
- The wallet id sent to the gateway comes from the backend's authenticated session, never from the app.

# 14. Testing: the simulator is your reference

**The simulator** is a pretend phone running the same library, with a console for the agent side, so you can see exactly what the app
should look like and do. An administrator opens it from Halo: **Settings, Channels, Vircle Chat, Open simulator** (it opens at
`https://chat.vircle.tech/simulator`). You can also run it on your own machine without any server:

```bash
cd gateway && npm install && npm run sim        # then open http://localhost:8090/launch
```

What to try there, as your specification:

- The **emoji** button (picker with search and categories) and the **+** button (Document, Photos & videos, Camera, Audio).
- The **GIF** button on the Agent tab: it makes a looping MP4 in the browser and sends it as the agent, so you can see a GIF arrive
  on the phone (a muted loop with a "GIF" tag).
- The **Agent** tab: send text, files and replies to the pretend user; the phone shows ticks, typing and quotes.
- The scenario buttons: reconnect after a gap, a message sent twice, Halo down then back, photos and voice notes both ways, replies,
  ticks, typing, and **Emoji and GIFs**. Each reports pass or fail per step.
- The **Wire log** tab shows every frame, as the library sends and receives it.

**Testing your real app** needs a live agent: use the **sandbox Halo workspace** (section 4.4). Sign in to the sandbox Halo as an agent
and answer from its inbox; the person in the app appears there as a contact with the Vircle Chat channel label.

## 14.1 Test plan before release

| # | Test | Expect |
| --- | --- | --- |
| 1 | First message from a fresh install | Appears in Halo within seconds; ticks reach delivered |
| 2 | Agent reply with the app open | Appears without refresh; "typing..." shows while the agent types |
| 3 | Agent reply with the app in the background and with it killed | Push arrives (once push is live); tap opens the chat with the reply |
| 4 | Aeroplane mode: write three messages, switch it off | All three send, in order, once each |
| 5 | Kill the app mid-upload of a photo | The message is marked not sent; Retry works |
| 6 | Emoji of every kind, including skin tones and flags | Identical on both sides |
| 7 | A GIF arrives (the simulator's Agent tab, later from Halo) | Plays by itself as a muted loop with a GIF tag, no controls, on iPhone and Android |
| 8 | Photo from the gallery (including a HEIC photo), from the camera, and a 20 MB video | JPEG under 1 MB; a video compressed under 16 MB or a helpful message |
| 9 | PDF and Word document | Arrive; the file name and size show; the agent can open them |
| 10 | Voice note of 3 seconds, 4 minutes, and over 5 minutes | Plays in Halo with the right length; the last is refused or stopped at 5 minutes |
| 11 | Reply to a support message; reply to your own | The quote shows on both sides |
| 12 | Read ticks: open the chat on the phone | The agent sees the messages as read; the badge goes to 0 |
| 13 | Two devices signed in as the same person | Both show every message; a fourth device replaces the oldest |
| 14 | Sign out and sign in as someone else | No trace of the first conversation |
| 15 | Dark mode, largest text size, screen reader, small phone, tablet | Readable and usable |
| 16 | A Huawei phone without Google services | Everything above works; push through Huawei Push Kit |

## 14.2 Devices

At least: one recent iPhone, one older iPhone, one Android 8 or 9 (old WebView), one current Android, one Huawei without Google
services. Old WebViews are where voice recording, emoji rendering and video playback differ.

# 15. Work breakdown and definition of done

| # | Task | Notes | Days (one engineer) |
| --- | --- | --- | --- |
| 1 | Environment, library install, `ChatService`, session call | Needs the backend endpoint (section 5) | 1 |
| 2 | Message list, bubbles, ticks, day dividers, scroll behaviour | 7.5, 7.6 | 3 |
| 3 | Composer: text, send/mic toggle, growing field, reply bar, swipe to reply | | 2 |
| 4 | Attach menu, photo and video pick, camera, preparation (shrink, compress, HEIC), caption preview | 8.1 to 8.3 | 4 |
| 5 | Documents and audio files; opening a received document | 8.1, 8.5 | 1 |
| 6 | Voice recording and the voice-note player | 8.4 | 3 |
| 7 | Emoji picker (search, categories, recent), large emoji-only messages | 9 | 2 |
| 8 | GIF display (a looping, muted, controls-free video) | 10 | 0.5 |
| 9 | Typing, connection bar, errors, retry, replaced state | 7.4, 12 | 1 |
| 10 | Unread badge, foreground and background handling, sign-out | 13.1 | 1 |
| 11 | Push alert handling and deep link | 11 (final testing after the push API) | 2 |
| 12 | Encrypted store (if required), permissions, CSP, accessibility, dark mode, translations | 13 | 3 |
| 13 | Device testing (section 14.1) and fixes | | 4 |
| | **Total** | A realistic range is **3 to 4 weeks**, with the backend endpoint ready on day one | **about 27** |

**Definition of done:** every row of the test plan passes on the device list; the checklist in 13.4 is signed off; no secret or token
appears in the code, the logs or the network traces other than the one-time connect token; the screens are translated; the
conversation is cleared on sign-out.

# 16. What you need from others, and open decisions

| Need | From | Needed by |
| --- | --- | --- |
| Session endpoint (`POST /chat/session`) in test and live | Vircle backend developer | Day 1 |
| Sessions key for the sandbox workspace and later the live one | Halo administrator, to the backend developer only | Day 1 |
| Sandbox Halo workspace with Vircle Chat connected, and an agent login | Platform operator and Halo administrator | Day 1 |
| Decision: should Halo agents be able to post GIFs? (section 10.2) | Product | Not blocking: the app shows one either way |
| Push API details, the payload fields, and the push registration for Huawei | Push team | Task 11 |
| App strings in each language, icons, and colour pairs for bubbles in both themes | Design | Task 2 |
| Decision: encrypted storage required? | Security | Task 12 |
| Decision: certificate pinning to `chat.vircle.tech`? | Security | Task 12 |

**Contacts and sources.** The library's README (inside the package) is the API reference. The protocol, if you need to see exactly what
travels, is `docs/vircle-chat-app-protocol.md`; the agreement with Halo is `docs/vircle-chat-contract.md`; running the gateway is
`docs/vircle-chat-gateway-runbook.md`. The simulator is the working example of everything in this document.
