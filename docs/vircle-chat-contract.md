# Vircle Chat: contract between Halo and the chat gateway

Version 1.1 draft, 3 October 2026 (1.1: push is the gateway's job, not Halo's; Halo's send also carries the contact's name, phone and email). Phase 0 of the Vircle Chat plan (`docs/vircle-chat-design.docx`).
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

## 8. Versioning and change

This is version 1. Additions that do not break a reader (new optional fields, new event types a receiver can
ignore, new `delivery` values the sender documents) stay in version 1; Halo ignores fields and events it does
not know. A breaking change is a `/v2` path and a new `Vircle-Contract-Version` header, announced in advance.

## 9. Testing without the real gateway

`node scripts/vircle-chat-mock.mjs` runs a stand-in gateway on localhost: it accepts Halo's
`POST /v1/messages` (checks the token and the idempotency key, answers `202`), and has commands that send
Halo correctly signed `message.inbound` and `message.receipt` events. See the header of the script.
