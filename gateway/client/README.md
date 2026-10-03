# @vircle/chat-client

The chat client for the Vircle app (Ionic, Angular, React, Vue or plain TypeScript). It owns the connection to the Vircle Chat
gateway and keeps an ordered list of messages, each with a status, so **your chat screen only has to draw them**. No dependencies;
works in a WebView (Android, iOS, Huawei) and in a browser.

The simulator (Halo, Settings, Channels, Vircle Chat, **Open simulator**) runs on this same library: its pretend phone is this code,
so what you see there is what the app gets. `client/src` is about 1,100 lines and worth a skim.

## What it does for you

| | |
| --- | --- |
| **Connect** | Asks your backend for a session, opens the socket, says hello with the highest message number it holds, and takes what it missed. |
| **Stay connected** | Pings the gateway and treats a missing answer as a dead connection. Reconnects with growing, randomised waits (1 s to 30 s). Reconnects at once when the network returns or the app comes to the foreground. |
| **Send** | Text and files get an id before anything is sent, so a message sent twice is stored once. While offline they wait and go out, in order, when the connection returns. A text written but not yet stored survives closing the app. |
| **Receive** | De-duplicated and ordered. A message that quotes another carries the quote. |
| **Ticks** | "Delivered" is reported for every message from support as it arrives; "read" while your chat screen is open. Your own messages move from `sent` to `delivered` to `read` as support receives and reads them, including changes that happened while the app was closed. |
| **Typing** | The user's typing is sent at most every 2.5 s; support's typing is `snapshot.supportTyping` for 6 s. |
| **Files** | Photos, video, voice notes and documents: validated, uploaded over HTTPS, then sent. Local preview while uploading; fresh links when old ones expire. |
| **Keep** | The conversation is kept on the device (`localStorageStore`), so the screen opens instantly, offline. |

## 1. Your backend: give the app a chat session

The app never talks to the gateway with a password. Your backend, which knows who is signed in, asks the gateway for a one-time
**connect token** and hands it to the app. The **sessions key** is the one printed when the workspace was registered on the gateway.

```js
// Node (Express); the same call from any language
app.post('/chat/session', requireSignedInUser, async (req, res) => {
  const r = await fetch('https://chat.vircle.tech/v1/sessions', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.VIRCLE_CHAT_SESSIONS_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ user: { wallet_id: req.user.walletId, name: req.user.name, phone: req.user.phone, email: req.user.email } }),
  })
  if (!r.ok) return res.status(502).json({ error: 'chat unavailable' })
  const { token, ws_path } = await r.json()   // token works once, for about a minute
  res.json({ token, wsPath: ws_path })
})
```

Send the phone and email if you have them: when the app is closed the gateway uses them to alert the user through your push API.
The identity comes from your backend, never from the app.

## 2. The app

```ts
import { VircleChatClient, localStorageStore } from '@vircle/chat-client'

const chat = new VircleChatClient({
  deviceId,                                   // stable per install (generate once, keep it)
  appVersion: '3.2.0',
  baseUrl: 'https://chat.vircle.tech',
  store: localStorageStore(`vircle-chat:${walletId}`),   // one key per signed-in user
  getSession: () => api.post('/chat/session'),            // your backend; called before EVERY connection (a token works once)
})

await chat.start()          // shows the kept conversation at once, then connects
```

Draw `chat.getSnapshot().messages`; subscribe to know when it changed.

```ts
const unsubscribe = chat.subscribe(() => render(chat.getSnapshot()))
```

A snapshot is one immutable object that is replaced whenever anything changes, so it works directly with React's
`useSyncExternalStore`, Angular signals (`signal(chat.getSnapshot())`, set it in the subscriber) and RxJS (`new BehaviorSubject`).

```ts
// React
const snap = useSyncExternalStore(chat.subscribe.bind(chat), chat.getSnapshot.bind(chat))
```

### The snapshot

| Field | Meaning |
| --- | --- |
| `messages` | In order. Each has `id` (a stable list key), `mine`, `kind`, `text`, `media` (with `animated` for a GIF), `replyTo`, `sender`, `sentAt`, and `status`: `sending`, `sent`, `delivered`, `read` or `failed` (with `error`). |
| `state` | `idle`, `connecting`, `online`, `offline` (retrying; `nextAttemptAt`), `replaced`, `stopped`. Show a thin "Connecting..." bar when it is not `online`; do not block the screen, because sending still works. |
| `supportTyping` | An agent is typing. |
| `loaded` | The history has been loaded at least once. Show a spinner only until it is true and the list is empty. |
| `limits` | `textMax`, `captionMax`, `fileMaxBytes` (known after the first connection). |

### Sending

```ts
await chat.sendText('Hi, I cannot top up')                    // resolves when stored; already in the list as "sending"
await chat.sendText('The savings one', { replyTo: message })  // quote a message
await chat.sendFile({ blob, name: 'receipt.jpg', type: 'image/jpeg' }, { caption: 'my receipt' })
await chat.sendFile({ blob: voice, name: 'note.m4a', type: 'audio/mp4' }, { durationSeconds: 12 })
await chat.sendGif({ url: mp4Url })                           // not needed by the Vircle app (no GIF picker): see "GIFs and emoji"
chat.retry(message.id)       // a message with status "failed"
chat.discard(message.id)
chat.typing()                // call on every keystroke: it sends at most every 2.5 s
```

`sendText` and `sendFile` reject with a `ChatError` (`.code`) for what can be refused before sending (`message_too_long`,
`file_type_not_allowed`, `file_too_large`) and for what the gateway refuses (the message is then `failed`). Allowed file types are the
same as WhatsApp: PNG, JPEG, WebP, MP4, 3GPP, AAC/MP4/MPEG/Ogg/AMR audio, PDF, Word, Excel, PowerPoint, plain text; 16 MB; voice notes up to 5 minutes.
Record voice notes in one of the allowed audio types (AAC in MP4 is the usual choice on iOS and Android).

### GIFs and emoji

**Emoji** are ordinary text: the keyboard's emoji, or your own picker, go into `sendText`. Skin tones, joined families, flags and keycaps
survive unchanged both ways (tested end to end). The limit is 4,000 characters counted as JavaScript counts them (an emoji is usually 2).

**GIFs** travel the way WhatsApp sends them: as a short looping **MP4** that plays muted with no controls. The Vircle app only has to
**show** one (no picker). `sendGif({ url })` (or `{ blob }`) exists for tools and tests and takes the MP4 of a GIF. A `.gif` file is refused with `gif_must_be_mp4`
(also from `sendFile`). A message with `media.animated === true` is drawn as `<video autoplay loop muted playsinline>` with no controls.
The Vircle app does not need `sendGif` (it has no GIF picker); it only shows GIFs that arrive.

### Showing a file

```ts
const url = await chat.getMediaUrl(message.id)   // use it as <img src>, <video src>, <audio src>
```

It returns the address the message has when that is good for another minute, and otherwise asks the gateway for a new one.
Video and audio play and seek on iOS (the gateway supports `Range`).

### The chat screen

```ts
chat.setScreenOpen(true)    // when the chat screen is visible: support's messages are reported as read
chat.setScreenOpen(false)   // when it is hidden (the app can stay connected in the background list)
```

### App lifecycle

The library reconnects by itself when the page reports `online`, `visibilitychange` or `resume` (Cordova/Capacitor). Also call
`chat.reconnectNow()` when:

* the app returns to the foreground (`App.addListener('appStateChange', ...)` in Capacitor);
* the user taps a **push alert** (the alert's deep link opens the chat screen: call `reconnectNow()` and the missed messages arrive).

When the user signs out: `chat.stop(); await chat.clearLocal()`.

```ts
chat.on('state', (s) => ...)                 // connection state changes
chat.on('message', ({ message, change }) => ...)   // 'added' or 'updated': e.g. play a sound for a new message from support
chat.on('typing', (on) => ...)
chat.on('error', ({ code, message }) => ...) // the connection itself (session failed, replaced); messages report their own errors
```

`replaced` means another connection of the same `deviceId` took over. The library does not fight for it: show the chat as
closed, and call `reconnectNow()` when the user asks for it.

## 3. Shipping the library

It has no dependencies and no build step of its own beyond `npm run build:client` in `gateway/`, which writes `client/dist/index.js` (ES module)
and `index.d.ts`. Copy `client/dist` into the app, publish it to your private registry, or add the folder as a path or git dependency.
For a quick start in a plain script: `gateway/public/vircle-chat-client.js` is the same code as one file with a global `VircleChat`.

## 4. Testing aids

* `interceptSend: (frame) => 'send' | 'drop' | milliseconds` swallows or delays a frame before it is sent (the simulator uses it to lose
  acknowledgements). Do not set it in production.
* `WebSocket` and `fetch` can be replaced (Node, tests): `new VircleChatClient({ WebSocket: require('ws'), ... })`.
* `backoff: { minMs, maxMs, factor, jitter }` shortens the reconnect waits in tests.
* The tests in `client/test` run the library against the real gateway (an in-process Postgres and a real WebSocket server).

## What is not in the library

The screen (bubbles, the composer, the photo picker, the voice recorder), the push notification registration (that is your push
infrastructure), and the deep-link handling. The protocol itself is described in `docs/vircle-chat-app-protocol.md` for anyone who
needs to speak it without this library.
