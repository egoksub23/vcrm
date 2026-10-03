# Vircle Chat: the app's connection to the gateway

For the developer of the Vircle app chat screen. **Most of this is done for you by the client library** (`gateway/client`, see its
README): connection, reconnect, resume, queueing, uploads, ticks and typing. Read this only if you need to speak the protocol yourself, or
to understand what the library does. Version 1 of the protocol, matching contract 1.2
(`docs/vircle-chat-contract.md`, which is the gateway's side with Halo). You can try every behaviour below
in the simulator (Halo, Settings, Channels, Vircle Chat, **Open simulator**): its pretend phone speaks exactly this
protocol, and `gateway/client/src/client.ts` is the reference client.

The source of truth is `gateway/src/protocol.ts` (frames) and `gateway/src/ws-server.ts` (behaviour).

## 1. How the app gets in

1. The user is signed in to the Vircle app. **Your backend** (never the app) asks the gateway for a session:

```
POST https://chat.vircle.tech/v1/sessions
Authorization: Bearer <sessions key>        # issued to your backend when the workspace was registered
{ "user": { "wallet_id": "W123", "name": "Aisha", "phone": "+60123456789", "email": "aisha@example.com" } }
```

   `wallet_id` is required; name, phone and email are optional but should be sent: the gateway uses the phone or email
   to alert the user when the app is closed. Answer `201`:

```
{ "token": "vcs_...", "expires_at": "...", "ws_path": "/ws", "conversation_id": "c_9f2a" }
```

   The token is for **one connection** and expires in about a minute. Your backend hands it to the app.
2. The app opens `wss://chat.vircle.tech/ws` and sends `hello` as its first frame within 10 seconds.

Every frame is one JSON text frame with a `type`. Binary frames are refused.

## 2. Frames, app to gateway

| Frame | Fields | Meaning |
| --- | --- | --- |
| `hello` | `v: 1`, `token`, `device_id`, `app_version?`, `last_seq?` | First frame. `device_id` is stable per install. `last_seq` is the highest message number the app already has; the gateway then replays what it missed. |
| `send` | `client_id`, `kind`, `text?`, `media?: { file_id }`, `reply_to?` | Send a message. `client_id` is a new unique id per message (a UUID): sending it again is safe and answered with the original. `kind` is `text`, `image`, `video`, `audio` or `document`. A file message names an **uploaded** file (section 4) and may carry a caption in `text`. `reply_to` is the `server_id` of the message being quoted. |
| `upload_request` | `request_id`, `kind`, `file_name?`, `mime_type`, `size_bytes`, `duration_seconds?`, `animated?` | Ask for an address to upload a file to. |
| `file_url` | `file_id` | Ask for a fresh link to a file in this conversation (the link in a message expired). |
| `receipt` | `up_to_seq`, `status: 'delivered' \| 'read'` | About **support's** messages: the app received them (`delivered`, send it as soon as they arrive) or showed them on the chat screen (`read`). Cumulative: everything up to that number. |
| `resume` | `last_seq` | Replay everything after `last_seq` (use after a gap, and to page through a long one). |
| `typing` | | The user is typing. Send it at most every 2 to 3 seconds while they type. |
| `ping` | `t?` | Keep-alive; answered with `pong`. |

## 3. Frames, gateway to app

| Frame | Fields | Meaning |
| --- | --- | --- |
| `welcome` | `v`, `server_time`, `heartbeat_s`, `limits`, `user`, `conversation: { id, last_seq }` | The hello was accepted. `limits` has `text_max`, `caption_max`, `file_max_bytes`, `send_per_window`, `send_window_s`. Use `server_time` to correct the phone's clock. |
| `ack` | `client_id`, `server_id`, `seq`, `conversation_id`, `duplicate?` | The message is stored. Show it as **sent** (one tick). `duplicate: true` means the gateway already had it. |
| `deliver` | `server_id`, `seq`, `conversation_id`, `direction`, `kind`, `text`, `media`, `reply_to`, `sender: { name }`, `sent_at`, `status` | A message to show. `direction: 'out'` is from support; `'in'` is the user's own (another device of theirs, or a replay). `status` is its current tick (`sent`, `delivered`, `read`). Show messages in `seq` order and ignore a `server_id` you already have. |
| `receipt` | `conversation_id`, `status: 'delivered' \| 'read'`, `messages: [{ server_id, seq }]` | About the **user's own** messages: `delivered` means support has received them (two ticks), `read` means an agent read them (two blue ticks). The gateway also sends one of each, after the replay, on **every connection** for the user's last 100 messages, so a tick that changed while the app was closed is not missed. |
| `typing` | `conversation_id`, `from: 'support'` | An agent is typing. Show "typing..." and clear it after about 6 seconds without another, or when a message arrives. |
| `upload_slot` | `request_id`, `file_id`, `upload_url`, `expires_at`, `max_bytes` | The answer to `upload_request`. |
| `file_url` | `file_id`, `url`, `expires_at` | The answer to `file_url`. |
| `resume_done` | `conversation_id`, `up_to_seq`, `more` | The replay finished at `up_to_seq`. If `more` is true, send `resume` again from there. |
| `pong` | `t` | Echoes `ping`. |
| `error` | `code`, `message`, `retry_after?`, `client_id?`, `request_id?` | Something was refused. `client_id` / `request_id` say which send or upload. |

`reply_to` on a message is `{ server_id, kind, text, from: 'you' | 'support' }`: the quoted message as a snapshot
(`text` is its first 140 characters, null for a file with no caption). `media` on a message is
`{ file_id, url, expires_at, mime_type, file_name, size_bytes, duration_seconds, animated? }`. `animated: true` is a GIF: an MP4
(`kind: "video"`, `video/mp4`) to play as a muted loop with no controls. A GIF is never uploaded as a `.gif` (`file_type_not_allowed`),
the way WhatsApp does it: ask the GIF service for the MP4 and send that with `animated: true` (the library does it: `sendGif`).

## 4. Sending a file (photo, video, voice note, document)

Bytes never travel on the socket.

1. Send `upload_request` with the file's real `mime_type`, exact `size_bytes` and, for a voice note, `duration_seconds`
   (at most 300). You get `upload_slot` (valid 15 minutes) or an `error` with the `request_id`.
2. `PUT` the bytes to `upload_url` over HTTPS with `Content-Type: <the declared mime_type>` and the exact byte count.
   No other headers or login are needed (the address is signed). It answers `201 { file_id }`, or an error:
   `401` bad address, `410` expired, `413` too large, `415` wrong type or content that is not that type, `400`
   size mismatch, `409` already uploaded. It works from a WebView (CORS is open on this address).
3. Send a `send` with `kind` and `media: { file_id }` (and `text` for a caption). Errors: `file_not_found`,
   `file_not_ready` (step 2 was skipped), `file_in_use` (that file was already sent), `bad_request` (wrong kind).

Allowed types (the same list as WhatsApp and the web widget): images PNG, JPEG, WebP; video MP4, 3GPP; audio
Ogg, MPEG, AAC, MP4, AMR; documents PDF, Word, Excel, PowerPoint, plain text. At most **16 MB**, and a voice note at most
**5 minutes**. Record voice notes as one of the allowed audio types (AAC in an MP4 container, or Ogg/Opus, are the
usual choices on iOS and Android). Slots: 20 per user every 10 minutes.

Showing a file: use `media.url` (it supports `Range` requests, so `<video>` and `<audio>` play and seek on iOS). The link
is valid for 24 hours; when it expires (a `410`), send `file_url` for a new one.

## 5. Staying connected

* The gateway pings every `heartbeat_s` (25 s) at the WebSocket level and drops a connection that misses two. Browsers and
  WebViews answer automatically; you may also send `ping`.
* A phone that backgrounds the app loses the connection: that is normal. **Reconnect with a new session token** (ask your
  backend again), send `hello` with `last_seq` and show what arrives. Back off between attempts (1 s, 2 s, 4 s ... up to 30 s,
  with a random jitter) and reset the delay after a connection that lasted.
* Close codes: `4401` token refused (get a new one), `4408` no hello in time, `4409` replaced by a newer connection of the
  same device, `4400` too many bad frames, `1012` the gateway is restarting (reconnect at once).
* Up to 3 devices per user can be connected; a message sent on one appears on the others.
* When the app is closed the user gets a push alert (generic text, a link to the conversation) from the gateway; on
  opening, `hello` with `last_seq` fills the gap. Send `receipt` `delivered` for each message you receive: if the gateway
  hears nothing for 5 seconds it assumes the app is asleep and raises the alert.

## 6. Limits and errors you may meet

| `code` | Meaning |
| --- | --- |
| `bad_frame` | The frame is malformed. Five in a row close the connection. |
| `unsupported_version` | `hello.v` is not 1. |
| `unauthorized`, `hello_required`, `hello_timeout`, `already_connected` | Connection state errors. |
| `message_too_long` | Text over 4,000 characters, or a caption over 1,024. |
| `rate_limited` | Too fast (30 messages per 10 s per user); `retry_after` seconds. |
| `file_type_not_allowed`, `file_too_large`, `file_not_found`, `file_not_ready`, `file_in_use` | See section 4. |
| `internal` | A fault on our side: try again. |

The simulator's **Wire log** tab shows every frame as it happens, which is the quickest way to learn the shapes.
