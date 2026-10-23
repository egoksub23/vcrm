# Vircle Chat: contract between Halo and the chat gateway

Version 1.3 draft, 21 October 2026 (1.3: older history on demand, a signed read from the gateway to Halo, section 3.5: an addition, nothing changed; 1.1: push is the gateway's job, not Halo's; Halo's send also carries the contact's name, phone and email. 1.2: files in both directions, replies that quote a message, "read" ticks back to the app, and typing indicators in both directions: all additions, nothing from 1.1 changed). Phase 0 of the Vircle Chat plan (`docs/vircle-chat-design.docx`).
This is what the Halo team and the gateway team agree **before** either writes code. Everything is plain
HTTPS with JSON, so each side can build and test against the mock in `scripts/vircle-chat-mock.mjs`.

## 0. Decisions this contract rests on

| Question | Answer (owner, 2 Oct 2026) | Effect here |
| --- | --- | --- |
| Is there a socket gateway? | No. **We build it** (scope: `docs/vircle-chat-gateway-scope.md`); the owner's developer then builds the app chat screen | The gateway is built against this contract, with a simulator to test chats before the app exists |
| What is the app? | Hybrid Ionic, three builds (Huawei, Android, Apple) | A WebSocket (WSS) client works in the WebView; raw TCP is not assumed |
| Push | A Vircle push API, called with a **phone number or email**; it finds the user and pushes. Details to follow. The gateway decides when to push; Halo never does | The gateway calls it. Halo holds no push credentials and has no push logic. See section 7 |
| One conversation per user? | Not answered; **assumed yes** | A user is addressed by `wallet_id`; the gateway's `conversation_id` is stable per user |
| Raw TCP vs WebSocket | Not answered; **WebSocket assumed** | Only the gateway-to-client side; this contract is unaffected |

## 1. Parties and trust

- **Gateway**: owned by the Vircle app backend. Authenticates the app user, holds connections and the offline
  queue, decides socket versus push for each message.
- **Halo**: stateless. Stores the conversation, runs the inbox, tickets, automations and AI replies.
- Halo trusts a user's identity **only** because the gateway vouches for it (server to server). Nothing a
  client types is believed.
- Each Halo workspace has its own connection: a `workspace_key` (public identifier), a **signing secret**
  (gateway signs what it sends to Halo) and an **API token** (Halo authenticates to the gateway). Both secrets
  are generated in Halo, shown once, and stored encrypted.

## 2. Signing (gateway to Halo)

Every webhook request carries:

```
X-Vircle-Timestamp: 1790000000            seconds since the Unix epoch
X-Vircle-Signature: sha256=<hex>          HMAC-SHA256(signing_secret, "<timestamp>.<raw request body>")
Content-Type: application/json
```

Halo rejects (HTTP 401) a request whose signature does not match, or whose timestamp is more than **300
seconds** from Halo's clock. It also remembers every `event_id` per workspace and answers a repeat with 200
and no effect, so a captured request cannot be replayed and a retried one cannot duplicate a message.
Compute the signature over the exact bytes sent; do not re-serialise.

## 3. Webhook: gateway to Halo

`POST https://<halo-host>/api/vircle-chat/webhook`

The workspace is found from `workspace_key` in the body, and the signature is verified with **that**
workspace's secret. A paused or suspended workspace answers `200` with `{"ok":true,"ignored":"paused"}`
so the gateway does not retry forever.

### 3.1 `message.inbound` (the user wrote)

```json
{
  "event": "message.inbound",
  "event_id": "evt_01JABCDEF",
  "workspace_key": "vcw_9f2c...",
  "user": { "wallet_id": "W123", "name": "Aisha", "phone": "+60123456789", "email": null },
  "conversation_id": "c_9f2a",
  "message": {
    "server_id": "m_77",
    "client_id": "6f1c...-uuid",
    "seq": 41,
    "type": "text",
    "text": "Hi, I cannot top up",
    "sent_at": "2026-10-02T09:15:00Z"
  }
}
```

- `user.wallet_id` is required. `name`, `phone` and `email` are optional but should be sent whenever the
  gateway knows them: they let Halo merge this person with the same customer on WhatsApp or email.
- `message.type` is `text`, `image`, `video`, `audio` or `document`. A file message adds
  `message.media` (see 3.3) and an optional `text` caption.
- `server_id` is the gateway's id for the message and is Halo's dedupe key for the message itself.
  `seq` is the per-conversation sequence number (informational in v1; Halo displays by `sent_at`).
- Limits: `text` up to 4,000 characters; a caption up to 1,024.
- **Replies (1.2).** `message.reply_to_server_id` (optional) is the gateway id of the message the user is replying to
  (a message Halo sent, whose id Halo got in the `202` answer, or an earlier message of the user's, whose id Halo got in
  `message.inbound`). Halo shows the new message as a reply to that one. An id Halo does not know is ignored.
- **Voice notes (1.2).** `message.media.duration_seconds` (optional whole number) is the length of a voice note.
- **GIFs (1.3).** `message.media.animated` (optional, `true`) marks a GIF. A GIF is never sent as a `.gif` file (WhatsApp does not
  accept them either): it is a short looping **MP4** (`type: "video"`, `mime_type: "video/mp4"`) with `animated: true`. Halo shows
  it as a muted loop with no controls instead of as a video. Any other value, or the flag on anything but an MP4, is ignored.

Answer `200 {"ok":true,"message_id":"<halo id>"}`. Any 5xx or timeout means "retry with the same
`event_id`"; the gateway should retry with back-off for at least 24 hours.

### 3.2 `message.receipt` (the user's app reports on a message Halo sent)

```json
{
  "event": "message.receipt",
  "event_id": "evt_01JABCDEG",
  "workspace_key": "vcw_9f2c...",
  "server_id": "m_78",
  "status": "delivered",
  "at": "2026-10-02T09:15:04Z",
  "error": null
}
```

`status` is `delivered` (the app received it), `read` (the chat screen showed it) or `failed`
(`error: { "code": "...", "message": "..." }`). Halo only ever moves a message forward
(`sent` to `delivered` to `read`); a late `delivered` after a `read` is ignored.

### 3.3 Files from the user

Files never travel through the socket or the webhook body. The gateway stores the file and gives Halo a
short-lived address to fetch it once:

```json
"media": {
  "url": "https://files.vircle.example/dl/abc?sig=...",
  "mime_type": "image/jpeg",
  "file_name": "receipt.jpg",
  "size_bytes": 182044
}
```

`url` must be `https`, valid for at least 10 minutes, and publicly reachable (Halo refuses private
addresses). Halo copies the file into its own private storage and does not keep the address. Allowed types
and the 16 MB ceiling are the same as for WhatsApp media; larger or other types are answered
`200 {"ok":true,"dropped":"unsupported_media"}` and the text, if any, is kept.

### 3.4 `user.typing` (the user is typing, 1.2)

```json
{
  "event": "user.typing",
  "event_id": "evt_01JABCDEH",
  "workspace_key": "vcw_9f2c...",
  "user": { "wallet_id": "W123" },
  "conversation_id": "c_9f2a",
  "at": "2026-10-02T09:14:58Z"
}
```

Signed like every other event, but **ephemeral**: it is sent once, never retried and not kept if Halo is down, and Halo
answers `200 {"ok":true}` and remembers nothing. The gateway sends at most one per user every 3 seconds while they
type; Halo shows "typing..." to the agent for about 6 seconds after the last one. A paused workspace answers
`200 {"ok":true,"ignored":"paused"}`.

### 3.5 `POST /api/vircle-chat/history`: the gateway asks Halo for earlier messages (1.3)

Built (23 Oct 2026). Confirmed by the owner (21 Oct 2026): only the Vircle Chat conversation is returned, and files older than the gateway's
retention are fetched by the gateway from Halo and streamed from the gateway's own address. A **read**, sent as a POST so it reuses the signing of section 2 unchanged. Same headers and the same 300-second clock rule;
Halo does **not** remember an `event_id` for reads (a retry must work).

```json
{
  "v": 1,
  "workspace_key": "vcw_...",
  "conversation_id": "c_9f2a",
  "wallet_id": "W123",
  "before": { "sent_at": "2026-09-01T10:00:00Z", "server_id": "m_..." },
  "limit": 30,
  "not_before": "2026-09-20T00:00:00Z"
}
```

Answer `200`:

```json
{
  "messages": [
    { "server_id": "m_...", "direction": "out", "kind": "image", "text": "caption", "sent_at": "2026-08-30T09:00:00Z",
      "status": "read", "sender": { "name": "Aisha" }, "reply_to": null,
      "media": { "file_name": null, "mime_type": "image/jpeg", "size_bytes": null, "duration_seconds": null, "animated": false } }
  ],
  "more": true
}
```

`before.server_id` is optional: it is left out when the app holds no message ("older than `sent_at`"). The answer carries `end: "start"` or `"window"` when `more` is false (sent at once if there are no messages at all).

Halo's rules.

* **Which messages**: the person's Vircle Chat conversation only (not their WhatsApp or web chat), direction `in` or `out`, **not** internal notes,
  assignments or system events, **not** failed sends. Ordered newest first by (`sent_at`, id), strictly older than `before`, then returned oldest
  first. `limit` is clamped to 1 to 50.
* **How far back**: the workspace's history limit, **90 days by default** (Settings, Channels, Vircle Chat, Older messages: 1 to 365 days). Older
  messages are never returned; `end: "window"` tells the app so. `not_before` can only make it shorter.
* `server_id` is the id the gateway gave the message (section 6), so the page de-duplicates against what the app already holds.
* **A page carries a file's description, never its address**: `mime_type` and `animated` are known; `file_name`, `size_bytes` and `duration_seconds`
  are `null` (Halo does not keep them). A file message whose file Halo no longer has arrives with `media: null`, and the gateway turns it into text.
* **The file itself is asked for separately, when the app opens it** (the file request below). The gateway fetches it with the checks it applies to
  any file from Halo, keeps it for a day and serves it from its own address, so the app only ever talks to one host.
* The answer is only for **that person's own conversation**: Halo checks that `wallet_id` is the contact the conversation belongs to.
* A person Halo does not know (no contact with that `wallet_id`) gets an empty page ending in `start`.
* Errors: `401` bad signature or clock, `400` a request that cannot be read, `404` (file requests only) no such file, `429` too many (with
  `Retry-After`), `503` try later (with `Retry-After`). A paused workspace answers `200 {"ok":true,"ignored":"paused"}` and the gateway shows an empty
  page with `end: "window"`.

**The file request** is the same address with `file_for` instead of `before`:

```json
{ "v": 1, "workspace_key": "vcw_...", "conversation_id": "c_9f2a", "wallet_id": "W123", "file_for": "m_..." }
```

Answer `200`:

```json
{ "media": { "download_url": "https://<halo-storage>/...", "kind": "image", "mime_type": "image/jpeg", "file_name": null,
             "size_bytes": null, "duration_seconds": null, "animated": false } }
```

`download_url` is a signed link from Halo's private media store, good for 24 hours; the gateway fetches it at once. Halo answers `404` for a message that
is not the person's own Vircle Chat message, has no file, is an internal note or is in the trash.

## 4. REST: Halo to gateway

```
POST https://<gateway>/v1/messages
Authorization: Bearer <api_token>
Idempotency-Key: <halo message id>
Content-Type: application/json
```

```json
{
  "recipient": { "wallet_id": "W123", "name": "Aisha", "phone": "+60123456789", "email": "aisha@example.com" },
  "conversation_id": "c_9f2a",
  "type": "text",
  "text": "Hi Aisha, checking now.",
  "sender": { "name": "Support" }
}
```

`recipient.wallet_id` is required; `name`, `phone` and `email` are what Halo knows about the contact and are sent
whenever it has them. The gateway needs the phone or email to name the recipient to the push API, including for a
user who has never opened the chat and so has no session yet.

A file message sets `type` to `image` / `video` / `audio` / `document` and adds
`media: { "url": "<signed address>", "mime_type": "...", "file_name": "...", "size_bytes": 0 }`; the gateway
fetches it within an hour. `conversation_id` is included when Halo has seen one for this user (from an inbound
event), omitted for a first outbound message.

**Replies (1.2).** `reply_to_server_id` (optional) is the gateway id of the message being quoted. The gateway shows the
app the quoted message beside the new one. An id the gateway does not know is ignored and the message is sent without a quote.

**Files (1.2).** The gateway fetches `media.url` while it handles the request (so the call can take a few seconds) and keeps
its own copy. It refuses a file it cannot fetch, that is over 16 MB, or whose type is not in the allowed list with `400`
`invalid_media`. `media.duration_seconds` (optional) is the length of a voice note. `media.animated` (optional, `true`, MP4 only, 1.3)
marks a GIF; the app then plays it as a muted loop. Today the app has no GIF picker and Halo's agent composer cannot attach a `.gif`,
so no production source produces one yet; the display is ready for when one does.

Success is `202`:

```json
{ "server_id": "m_78", "seq": 42, "conversation_id": "c_9f2a", "delivery": "socket" }
```

`delivery` says what the gateway did: `socket` (sent to a live connection), `push` (the gateway raised the
alert itself), `queued` (kept for the next time the app connects; no alert was raised) or `no_device` (the
user has no app installed or registered). Halo shows all four as "sent" and does nothing more (section 7).

The same `Idempotency-Key` returns the same answer and never a second message, for at least 24 hours.

Errors are `4xx`/`5xx` with `{ "error": { "code": "...", "message": "..." } }`. Halo treats `429` and `5xx` as
retryable (honours `Retry-After`) and everything else as final, surfaced as "Not sent" with the message:

| Code | Meaning |
| --- | --- |
| `user_not_found` | no such `wallet_id` |
| `unauthorized` | bad or revoked API token |
| `rate_limited` | slow down (HTTP 429, `Retry-After`) |
| `invalid_media` | the file could not be fetched or is not allowed |
| `message_too_long` | over the text limit |
| `blocked` | the user opted out or is barred from chat |

### 4.0 `POST /v1/sessions-key`: Halo asks for a new sessions key (1.3 draft)

Behind the **Generate sessions key** button on Halo's Vircle Chat settings. Authenticated with the API token like every Halo call. The gateway makes a
new sessions key (`vgs_...`, the credential the Vircle **backend** uses for `POST /v1/sessions`), keeps only its hash, retires the old one **at once**,
and answers `201 {"sessions_key": "vgs_..."}` with `Cache-Control: no-store`. Halo shows it once and does not store it. `401` for a bad token. A
gateway that predates this call answers `404`, which Halo reports as "update the gateway".

### 4.1 `POST /v1/receipts`: the agent read the user's messages (1.2)

```
POST https://<gateway>/v1/receipts
Authorization: Bearer <api_token>
```

```json
{ "recipient": { "wallet_id": "W123" }, "status": "read", "server_ids": ["m_41", "m_42"] }
```

Tells the gateway that an agent has read these messages of the user's, so the app can show them as read. `status` is
`read`; up to 200 ids; an id the gateway does not know, or one that is not the user's, is ignored; a status only moves forward
(`sent`, `delivered`, `read`), so a repeat changes nothing. Answer `202 {"updated": 2}`.

The gateway marks a user's message `delivered` by itself as soon as Halo has accepted its `message.inbound` event (so the
app can show that support received it); Halo only ever needs to send `read`.

### 4.2 `POST /v1/typing`: an agent is typing (1.2)

```json
{ "recipient": { "wallet_id": "W123" } }
```

Shows "typing..." in the user's app, if it is open. Not stored, no push. Answer `202 {"delivered_to": 1}` (the number of live
connections it reached; 0 when the app is closed). Halo sends it at most once every 3 seconds while an agent types.

## 5. Connection health

`GET https://<gateway>/v1/health` with the bearer token answers `200 {"ok":true}`. Halo's "Test connection"
button calls it and shows the result.

## 6. Mapping onto Halo

| Gateway | Halo |
| --- | --- |
| `user.wallet_id` | `contacts.wallet_id`; the contact is matched by it first, then by phone or email, and the wallet id is added to the match |
| `message.inbound` | an inbound message, channel `vircle_chat`, unread, running automations and AI replies like any inbound |
| `server_id` | the message's external id (dedupe, and the key receipts refer to) |
| `delivery` / `receipt` | `sent` / `delivered` / `read` / `failed` ticks and the "Not sent" handling |
| `conversation_id` | stored on the Halo conversation so a later outbound message carries it |

One conversation per contact, the same as the web widget: a user who also writes from the web widget or
WhatsApp is the same contact with one merged history.

## 7. Push alerts

Decided by the owner, 3 Oct 2026: **the gateway alone decides** between a socket and a push for each
message, and it raises the push itself through the Vircle push API (which takes a phone number or an
email and finds the user and device). Halo never sends a push and holds no push credentials.

For Halo this means nothing more than the `delivery` value in section 4: `socket`, `push` or `queued`
(the user could not be alerted yet; the message waits for their next connection) are all shown as "sent",
and `delivered` / `read` follow as receipts when the app reports them. A user the gateway cannot reach at
all (`no_device`) is also "sent"; the agent sees no tick beyond that.

The gateway needs the user's phone and email to name the push recipient, which is why section 3.1 asks
for them on every event, and why the user's session token (the gateway's own, see
`docs/vircle-chat-gateway-scope.md`) carries them.

**What the alert carries** (agreed with the app team, 23 Oct 2026; the push team still has to confirm that the push API passes custom string fields
through unchanged):

```json
{ "notification_type": "01", "chat_alert": "1", "conversation_id": "c_9f2a",
  "deep_link": "https://app.vircle.com/chat/c_9f2a" }
```

All four are strings. `notification_type` stays `"01"` like every other Vircle alert; **`chat_alert` is what marks a chat alert** (the app tests
`data.chat_alert === "1"` and nothing else). The deep link is a universal link (iOS) / App Link (Android) to `https://app.vircle.com/chat/{conversation_id}`;
a workspace can override it (and the title and text) with `push_settings` on the gateway (`update-workspace --deep-link ...`).
## 8. Versioning and change

Version 1.3 adds one signed read address (section 3.5, older history: a page of messages, and a fresh link for one message's file). Version 1.2 only adds fields and calls (replies, voice-note length, `user.typing`, `/v1/receipts`, `/v1/typing`); a 1.1 gateway
or a 1.1 Halo keeps working with a 1.2 peer, because each side ignores what it does not know.

This is version 1. Additions that do not break a reader (new optional fields, new event types a receiver can
ignore, new `delivery` values the sender documents) stay in version 1; Halo ignores fields and events it does
not know. A breaking change is a `/v2` path and a new `Vircle-Contract-Version` header, announced in advance.

## 9. Testing without the real gateway

`node scripts/vircle-chat-mock.mjs` runs a stand-in gateway on localhost: it accepts Halo's
`POST /v1/messages` (checks the token and the idempotency key, answers `202`), and has commands that send
Halo correctly signed `message.inbound` and `message.receipt` events. See the header of the script.
