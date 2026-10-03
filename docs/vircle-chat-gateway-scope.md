# Vircle Chat gateway: scope

Draft for the owner's decision, 3 October 2026. Companion to `docs/vircle-chat-contract.md`
(the Halo to gateway contract) and `docs/vircle-chat-design.docx`.

## 1. Where this stands

Halo's side of Vircle Chat is built and live. There is **no gateway yet, and we build it**. When it
works, with a simulator proving it end to end, your developer builds the chat screen in the app on top
of it.

Your decision on push: the **gateway alone** chooses, per message, between sending over the live
connection and raising a push. It does that by calling **your** push API with a phone number or email, so
nothing here needs Firebase, APNs or Huawei credentials. Halo never pushes.

## 2. What the gateway is

One small standalone service, in this repository (`gateway/`), run as its own container next to Halo.
It sits between three parties:

```
 Vircle app  <--WSS-->  GATEWAY  <--HTTPS, signed-->  Halo (inbox, tickets, AI)
 (Ionic)                   |
                           +--HTTPS-->  Vircle push API (phone or email)
                           +--HTTPS-->  Vircle backend (mints chat sessions)
```

It owns: live connections, who is online, the per-conversation message order, the queue of messages a user
has not received yet, the socket-or-push decision, files in transit, and the retry of everything it tells
Halo. It owns no customer-care logic: agents, tickets, automations and AI replies stay in Halo.

## 3. What gets built

| # | Piece | What it does |
| --- | --- | --- |
| 1 | **App connection (WebSocket over TLS)** | The protocol in the design document: `hello`, `welcome` (limits, clock, heartbeat), `send` / `ack` (client id for idempotency), `deliver`, `receipt` (delivered, read), `typing`, `resume` from the last sequence, `ping`/`pong`, `error`. Per-conversation sequence numbers, duplicates absorbed, replay after reconnect. |
| 2 | **Sessions (how a user is let in)** | Your backend calls the gateway (`POST /v1/sessions`, server to server, with an API key) with who the user is (wallet id, name, phone, email). The gateway returns a one-time connect token valid for about a minute; the app connects with it. The user's identity therefore comes from your backend, never from the app. |
| 3 | **Halo side of the contract** | Receives Halo's `POST /v1/messages` and `GET /v1/health`; sends Halo signed `message.inbound` and `message.receipt` events through an outbox that retries for 24 hours, so a Halo outage loses nothing. |
| 4 | **Delivery decision** | For each message to a user: live connection, deliver and wait for the app's acknowledgement (about 5 seconds); no connection or no acknowledgement, keep it queued and ask the push API to alert the user (generic text, deep link to the conversation, one alert per conversation per away period). |
| 5 | **Push adapter** | One interface, `send({ phone, email, title, body, deepLink, collapseKey })`. Two implementations: the **mock** (records the push, used by the simulator and tests) and the **Vircle push API** (written the day you give me its details; about a day). |
| 6 | **Files** | Files never go through the socket. The app asks for an upload address, uploads over HTTPS; the gateway stores it and gives Halo a short-lived download link. For a file from an agent, the gateway fetches Halo's link, stores a copy and gives the app its own link. 16 MB limit, same types as Halo. |
| 7 | **Workspaces (tenants)** | A workspace is one Halo workspace's connection: its key, Halo's webhook address, the signing secret, the API token, push settings. Built for several from day one (it costs almost nothing now and a lot later), used by one at first. |
| 8 | **Storage** | A dedicated Postgres database (conversations, messages with sequence, the Halo outbox, push log, sessions). Who is online lives in memory. Messages are purged after delivery plus a retention period (default 30 days). |
| 9 | **Client library** | A TypeScript package for the Ionic app: connect, reconnect with back-off and jitter, resume, send with ids, receipts, typing, upload. Your developer uses it and builds only the screen. The simulator uses the same library, so what it proves is what the app gets. |
| 10 | **Simulator** | See section 4. |
| 11 | **Operations** | Container image, `docker compose` service beside Halo, a public WSS hostname (for example `chat.vircle.tech`) behind TLS, health and metrics endpoints, structured logs, per-user and per-connection rate limits, graceful restart (clients resume), nightly database backup, runbook. |

## 4. The simulator

A web page served by the gateway on staging (switched off in production). It is both our test tool and
what you use to see a chat working before the app exists.

- **Phone panel.** Pick or create a test user (wallet id, name, phone, email), connect or disconnect (this is
  "app open" versus "app closed"), see the chat with sent / delivered / read ticks, send text and files,
  typing indicators.
- **Push inbox.** Shows each push the gateway would have sent, with its text and deep link, and a "tap" button
  that opens the phone at that conversation. Until your push API exists this is the mock; afterwards it can
  also show what the real API answered.
- **Wire log.** Every frame in both directions, and every call to and from Halo with its status and timing.
- **Fault buttons.** Drop the connection, delay or swallow the acknowledgement, send the same message twice,
  replay an old event, take Halo offline, so each reliability rule is something you can watch work.
- **Scripted scenarios**, the same ones run automatically in tests: agent replies while the app is open;
  while it is closed (push, then resume); a lost acknowledgement (push fallback); a reconnect that replays
  the gap; a duplicate send; Halo down for ten minutes (outbox drains in order).
- It talks to the **real Halo** (a workspace connected in Settings, Channels) or to a built-in fake Halo, so
  it works before anything is deployed.

## 5. Changes in Halo (small)

- Done (3 Oct 2026, migration 149): the "Push alerts from Halo" switch, its stored setting and the call in the
  send path are removed. The contract says Halo never pushes.
- Done: Halo's send now carries the contact's name, phone and email (contract 1.1), so the gateway can name the
  recipient to the push API even for a user who has never opened the chat.
- Nothing else changes: `delivery` is shown as "sent" whatever the gateway answered.

## 6. Plan and effort

One engineer working alone. Days are working days.

| Step | Work | Days |
| --- | --- | --- |
| 0 | Halo clean-up above; contract 1.1 | 0.5 |
| 1 | Gateway skeleton, storage, workspaces, sessions, the WebSocket protocol with sequence, idempotency and resume | 5 |
| 2 | Halo side: receive sends, signed events with a retrying outbox, receipts | 3 |
| 3 | Delivery decision, push adapter with the mock, away-period rule | 2 |
| 4 | Files | 2 |
| 5 | Client library | 3 |
| 6 | Simulator and the scripted scenarios | 4 |
| 7 | Deployment, TLS hostname, backups, load test (a thousand idle connections and a burst), runbook. **Done 3 Oct 2026** (`vircle-chat-gateway-loadtest.md`, `vircle-chat-gateway-runbook.md`); the backup scripts and Docker/nginx settings still need their first run on the server | 3 |
| | **Total** | **about 22 days, 4 to 6 weeks with review and fixes** |
| 8 | Real push API adapter, once you provide the details | 1 to 2 |

You can try the first useful milestone after step 3 (about 2.5 weeks): the simulator-less version, driven by
the mock script, with a real chat between Halo and a scripted phone.

## 7. What I need from you

1. **The push API**: endpoint and authentication, request fields, what it answers for an unknown user or a
   user with no device, and the wording and deep link format you want. (Step 8; everything else runs on the
   mock until then.)
2. **A hostname for the gateway** (a new DNS name, for example `chat.vircle.tech`) pointing at the server it
   runs on. A WebSocket needs its own public address with TLS.
3. **Where it runs.** Recommended: the same server as Halo for the pilot (one more container and its own
   database), moving with the database to AWS later. The risk is one machine for both; the gain is nothing new
   to buy or operate.
4. **Your backend developer**: one small call, "when a signed-in user opens the chat, ask the gateway for a
   session" (about half a day on their side, with a sample I will write).
5. **Retention**: how long the gateway keeps messages after delivery (default 30 days).
6. **Go-ahead**, and your reading on the 4 to 6 week range.

## 8. Not in this scope

- The chat screen, deep-link handling and the push-tap behaviour inside the app (your developer; I supply the
  client library, the protocol notes and the simulator).
- The push infrastructure itself (FCM, APNs, Huawei): yours, behind your API.
- Several gateway instances, regions or automatic failover: the design allows it (state is in the database
  and one small shared channel), but one instance carries the pilot. Add it when the numbers ask for it.
- Voice and video calls, read receipts shown to the customer for agent typing, end-to-end encryption.

## 9. Risks

- **Long-lived connections on one server.** A thousand idle connections is easy; the load test in step 7
  puts a number on it before the pilot.
- **iOS and Android suspend a backgrounded app.** The socket will drop when users leave the app; the design
  assumes it (that is why push and resume exist), and the simulator's fault buttons exercise it.
- **The push API's behaviour is unknown until we see it.** Mitigated by the adapter boundary: only one file
  changes.
- **Identity.** If your backend cannot call the gateway when the chat opens, the alternative is a signed token
  your backend produces itself (the same style as the web widget's identity token); a day more on my side.
