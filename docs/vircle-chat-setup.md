# Vircle Chat setup

Vircle Chat is the inbox channel for the **Vircle mobile app's in-app customer chat**. A customer
types in the app; a gateway run by the Vircle app team carries the message to Halo; your agents
(and automations and AI replies) answer from the Inbox; the reply goes back through the gateway to
the customer's app. Halo never talks to the app directly: the gateway owns the connection to the
phone and the offline queue, and Halo owns the conversation.

The two sides agree on everything in [`vircle-chat-contract.md`](./vircle-chat-contract.md)
(signing, the webhook, the REST call Halo makes, receipts, files). This page is the Halo
administrator's side: how to switch the channel on, connect it and check it works.

## 1. Prerequisites

1. **The operator turns the flag on.** Vircle Chat is off for new workspaces. A platform operator
   opens the Platform console, finds the workspace, and switches on the **Vircle Chat** module
   (Modules section). Until then the Settings tab does not appear and every Vircle Chat route
   answers 403 "Vircle Chat is not enabled for this workspace". Switching it off later stops the
   channel (the webhook answers 200 and ignores events; nothing is sent) without deleting the
   connection.
2. **The gateway team builds against the contract.** They need
   [`vircle-chat-contract.md`](./vircle-chat-contract.md) and the mock in
   `scripts/vircle-chat-mock.mjs`. They do not need access to Halo. What they need *from you* is
   the four values in step 2 below.
3. **Halo has a public address.** The webhook address shown in Settings is built from
   `NEXT_PUBLIC_SITE_URL` (see `.env.local.example`); set it explicitly, as for every other channel.
4. **Your role can manage channels** (`channels.manage`: Owner and Admin by default).
5. **Database migrations 147 and 148 are applied** (self-hosters: see `CHANGELOG.md`).

## 2. Connect it (Settings, Channels, Vircle Chat)

1. Open **Settings, Channels** and choose **Vircle Chat**.
2. Type the **gateway address** the gateway team gave you (for example
   `https://chat-gateway.example.com`). It must be `https`, with no username, password, query or
   fragment. Press **Save and connect**.
3. Halo creates the connection and shows **four values for the gateway team**:

   | Value | What it is | Shown |
   | --- | --- | --- |
   | Workspace key | Public identifier (`vcw_...`); the gateway puts it in every event so Halo knows which workspace it is for | always |
   | Webhook URL | Where the gateway posts events (`https://<your-halo>/api/vircle-chat/webhook`) | always |
   | Signing secret | The gateway signs every event with it (`vcs_...`) | **once** |
   | API token | Halo presents it to the gateway on every call (`vct_...`) | **once** |

   The two secrets are shown on this screen only once, right after the first save (and again once
   after each rotation). Copy them now and hand them to the gateway team over a safe channel. They
   are stored encrypted and cannot be displayed again.
4. Press **Test connection**. Halo calls `GET /v1/health` on the gateway with the API token. A tick
   means the address, the token and the gateway are all fine; otherwise the message says what
   failed (the gateway refused the token, answered with an error, or could not be reached).
5. The channel is live. Customers' messages arrive in the Inbox with the **Vircle Chat** channel
   label.

Other controls on the same screen:

- **Pause switch** (top right): stops receiving and sending without losing the connection or the
  secrets. A paused workspace answers the gateway `200` (so it does not retry for ever) and ignores
  the event.
- **Rotate secret / Rotate token**: generate a new value (after a confirmation) and show it once.
  The old value stops working at once, so give the new one to the gateway team straight away. A
  lost secret is never recoverable, only replaceable.
- **Last message received** and **Last error**: the most recent inbound time and the most recent
  problem Halo hit while handling an event from the gateway (cleared by the next good event).
- **Disconnect**: deletes the connection and its secrets. Conversations and contacts are kept. To
  reconnect, save the address again and give the gateway team the new values; the old workspace key
  stops being recognised.

## 3. Test without the real gateway

`scripts/vircle-chat-mock.mjs` is a stand-in gateway with no dependencies (Node 18+). Its header
documents every flag.

1. Let the deployment accept a local gateway. This is a **deployment** setting, not a workspace
   one, and must stay unset in production:

   ```
   VIRCLE_CHAT_ALLOW_LOCAL_GATEWAY=true
   ```

   Without it Halo only accepts public `https` gateway addresses and refuses private and local
   addresses (the gateway address is typed by a workspace admin, so every call is address-checked
   and redirects are never followed). With it, `http://localhost` and `http://127.0.0.1` are also
   accepted. Restart Halo after changing it.
2. Start the mock gateway (the side Halo calls) and note the token it prints:

   ```
   node scripts/vircle-chat-mock.mjs serve --port 4010 --token <the API token from Halo>
   ```

   Use `--delivery queued` or `--delivery no_device` to see the queued paths, and
   `--fail user_not_found` (or another contract error code) to see "Not sent".
3. In Settings, Channels, Vircle Chat save the address `http://localhost:4010`, copy the signing
   secret and API token, and restart the mock with that token if it was started with another.
   Press **Test connection**.
4. Pretend to be a customer writing:

   ```
   node scripts/vircle-chat-mock.mjs inbound --halo http://localhost:3000 \
     --key <workspace key> --secret <signing secret> \
     --wallet W123 --name Aisha --phone +60123456789 --text "Hi, I cannot top up"
   ```

   The message appears in the Inbox. Reply to it: the mock prints the request Halo made.
5. Send a receipt for that reply (the `server_id` is in the mock's output):

   ```
   node scripts/vircle-chat-mock.mjs receipt --halo http://localhost:3000 \
     --key <workspace key> --secret <signing secret> --server-id m_1 --status read
   ```

6. Check the safety behaviour: add `--replay` to an `inbound` call (the second copy must be a
   no-op, one message only) and `--stale` (signed ten minutes ago; Halo must answer 401).

## 4. How contacts are matched

The gateway vouches for who the user is, so Halo treats the identity as **verified**.

- The user's **wallet id** is the channel's own key: it is stored on the contact (`wallet_id`) and a
  returning user always lands on the same contact.
- Halo also looks at the user's **phone and email**, when the gateway sends them (it should whenever
  it knows them). If they match an existing contact, for example the same person on WhatsApp or by
  email, that is the same customer: the records are merged into one contact with one history, and
  the wallet id is added to it. If a merge is not possible, Halo records the pair as a suggested
  duplicate for a person to decide.
- A user with only a wallet id and no phone or email becomes a new contact until a later event
  (or the web widget, or an agent) supplies one.
- Like the web widget, there is **one conversation per contact**. A customer who writes from the
  app and the web widget is the same contact with one merged thread. The gateway's
  `conversation_id` is stored on the conversation so later replies carry it.

## 5. Delivery ticks and "Not sent"

Each reply shows the usual ticks:

| Tick | Meaning |
| --- | --- |
| Sent | The gateway accepted the message (`202`). Whether it went over a live socket, was pushed, or was queued, Halo shows "sent" |
| Delivered | The gateway reported `message.receipt` `delivered`: the app received it |
| Read | The gateway reported `read`: the chat screen showed it |
| Not sent | The gateway refused it (for example `user_not_found`, `blocked`, `invalid_media`, `message_too_long`) or the API token was rejected. The message appears as "Not sent" with the gateway's reason |

Halo only moves a message forward: a late `delivered` after `read` is ignored. A `429` or `5xx`
from the gateway is retried (honouring `Retry-After`); anything else is final. The same
`Idempotency-Key` (the Halo message id) is used on every retry, so a message is never duplicated.

## 6. Push alerts (the gateway's job)

The gateway alone decides whether a reply goes over a live socket, as a push, or waits in the
queue, and it calls the Vircle push API itself (by phone number or email, with a generic message
and a deep link). Halo never sends a push for Vircle Chat, holds no push credentials, and has no
push setting: there is nothing to switch on in Settings. Halo only reads the `delivery` value the
gateway answers with (`socket`, `push`, `queued` or `no_device`) and shows every one of them as
"sent" (section 5). To change when a customer is alerted, change the gateway, not Halo.

(The web widget has its own separate, still inactive placeholder for app pushes,
`src/lib/widget/notify-app-push.ts`. It is not used by Vircle Chat.)

## 7. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| No "Vircle Chat" tab in Settings, Channels | The operator flag is off for this workspace (section 1), or your role cannot manage channels |
| Every call answers 403 "not enabled for this workspace" | Same: the operator flag is off, or the workspace is suspended |
| "The gateway address must start with https://" | A local `http://` address needs `VIRCLE_CHAT_ALLOW_LOCAL_GATEWAY=true` on the Halo deployment (testing only) |
| Test connection: "could not be reached" | Wrong address, the gateway is down, the address is private or local, or the gateway redirects (Halo does not follow redirects) |
| Test connection: "refused the API token" | The gateway has not been given the current token, or it was rotated |
| The gateway gets `401` from the webhook | Wrong signing secret on their side, a signature computed over re-serialised JSON instead of the exact bytes, a clock more than 300 seconds off, or an unknown workspace key |
| The gateway gets `200` with `"ignored":"paused"` | The pause switch is off, or the operator flag is off |
| Messages arrive twice | They should not: Halo remembers every `event_id` per workspace and every message `server_id`. Check the gateway reuses the same `event_id` on a retry |
| A file from the user did not arrive but its text did | Unsupported type, over 16 MB, or the download address expired or is private. The answer is `200` with `"dropped":"unsupported_media"` |
| Replies show "Not sent" | Open the message for the gateway's reason (the settings screen's **Last error** covers events received from the gateway, not sends) |
| "The stored API token cannot be read" | The encryption key changed. Rotate the API token |

## 8. Security notes

- **Signed webhooks.** Every event carries `X-Vircle-Timestamp` and
  `X-Vircle-Signature: sha256=<hex>`, an HMAC-SHA256 of `<timestamp>.<raw body>` with the
  workspace's signing secret. Halo checks it in constant time against **that** workspace's secret,
  rejects a timestamp more than **five minutes** (300 seconds) from its own clock, and answers
  `401` otherwise. An unknown workspace key and a wrong signature look the same from outside, and an
  address that keeps failing is rate limited.
- **Replay protection.** Halo remembers every `event_id` per workspace and answers a repeat with
  `200` and no effect, so a captured request cannot be replayed and a retried one cannot duplicate
  a message.
- **Secrets are stored encrypted and shown once.** The signing secret and API token are encrypted
  with the application key (and are included in the key-rotation re-encrypt job), are never
  returned by any read endpoint, not even in encrypted form, and appear in plaintext only in the
  response that creates or rotates them (`Cache-Control: no-store`).
- **Files are copied into private storage.** A file from a customer is fetched once from the
  gateway's short-lived address (`https`, publicly reachable; private addresses are refused), copied
  into Halo's private storage and shown to agents through signed links. Halo does not keep the
  gateway's address.
- **The gateway address is checked.** It is typed by a workspace admin, so every call to it goes
  through Halo's address-pinning fetch: the address actually connected to is checked, and a
  redirect is never followed.
- **Who may change it.** Only people with `channels.manage`, and only while the operator flag is on.
  The connection table is protected by the same capability in the database.
