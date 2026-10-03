# Vircle Chat gateway

The service between the Vircle app and Halo. Scope: `docs/vircle-chat-gateway-scope.md`. Contract with
Halo: `docs/vircle-chat-contract.md`. It is its own package (own `package.json`, tests and tsconfig) and is
not part of Halo's build or its Docker image.

## What is built

| Work package | State |
| --- | --- |
| 1. Storage, sessions, the app WebSocket protocol | done |
| 2. Halo side: `POST /v1/messages`, `GET /v1/health`, signed events with a retrying outbox | done |
| 3. Delivery decision: socket or push, one alert per away period, push adapter interface and mock | done |
| 6 (part). Simulator page, scenarios, launch from Halo | done; the client library it will use is WP 5 |
| deploy files (compose, Dockerfile, proxy notes) | written, not yet run on the server |
| 4. Files in both directions (upload slot, fetch from Halo, signed links, ranges), contract 1.2 extras: replies, read ticks back to the app, typing both ways | done |
| 5. Client library for the app (`client/`, its own README), the simulator now runs on it | done |
| 7. Operations: retention, `/metrics`, `/readyz`, JSON logs, parallel event sending, whole suite on real Postgres 16, load test, backup and restore scripts, runbook | done (the scripts and Docker/nginx settings are written, not yet run on the server) |
| 8. Real push adapter | waiting for the push API details |

Files: the app asks for an upload slot over the socket and PUTs the bytes over HTTPS; Halo's files are fetched by the gateway; both are kept in the `files` table and served by signed links (`docs/vircle-chat-app-protocol.md`).

A message from Halo goes to the user's live connection if they have one (`delivery: "socket"`). If the app does
not acknowledge it within 5 seconds, or the user has no connection, the gateway asks the push API to alert them
(`"push"`; `"no_device"` if the API knows no device; `"queued"` if no alert was raised). Today the push API is
the **mock** (`PUSH_ADAPTER=mock`, the default): alerts are recorded, never sent. The real adapter is work
package 8, when the push API's details are known. Details: the header of `src/delivery.ts`.

## Run the tests

```
cd gateway
npm install
npm test            # about 290 tests (gateway and client library), about 5 minutes; an in-process Postgres (PGlite), no Docker needed
npm run typecheck
```

`test/contract-halo.test.ts` runs Halo's own client and parsers (`../src/lib/vircle-chat`) against the
gateway, so a change on either side that breaks the other fails there.

## Run it

Needs a Postgres database and a 64-hex-character key that encrypts the stored webhook signing secrets.

```
export DATABASE_URL=postgres://user:pass@host:5432/gateway
export GATEWAY_ENCRYPTION_KEY=$(openssl rand -hex 32)   # keep it; losing it means re-entering the secrets
npm run dev                                              # applies migrations, listens on PORT (default 8090)
```

Settings (environment): `PORT`, `GATEWAY_WS_PATH` (`/ws`), `SESSION_TTL_SECONDS` (60), `HEARTBEAT_SECONDS`
(25), `HELLO_TIMEOUT_MS` (10000), `MAX_DEVICES_PER_USER` (3), `SEND_RATE_LIMIT` / `SEND_RATE_WINDOW_MS` (30 per
10 s), `REPLAY_BATCH` (200), `TEXT_MAX` (4000), `CAPTION_MAX` (1024), `FILE_MAX_BYTES` (16 MB),
`DISPATCH_POLL_MS` (2000), `DISPATCH_TIMEOUT_MS` (10000), `DISPATCH_MAX_BACKOFF_S` (900),
`DISPATCH_GIVE_UP_HOURS` (72), `MAX_HALO_BODY_BYTES` (64 KB), `PUSH_ADAPTER` (`mock`), `PUSH_ACK_TIMEOUT_MS` (5000),
`PUSH_SWEEP_MS` (1000), `PUBLIC_BASE_URL` (the https address file links are built from), `UPLOAD_SLOT_MINUTES` (15), `APP_FILE_LINK_HOURS` (24),
`HALO_FILE_LINK_HOURS` (1), `FILE_FETCH_TIMEOUT_MS` (20000), `MAX_VOICE_SECONDS` (300),
`PUSH_WINDOW_MINUTES` (60), `PUSH_REALERT_HOURS` (24), `PUSH_DEEP_LINK`
(`vircle://chat/{conversation_id}`; a workspace can override the title, text and link in `push_settings`).

## The simulator

A page served by the gateway (`/simulator`, files in `public/`) for trying the chat without the app: a pretend
phone that speaks the real WebSocket protocol, the push inbox (what the gateway would have sent), the agent's
view of the conversation with sent / delivered / read ticks, the calls to Halo (state, retries, replay), a wire
log, fault buttons (drop the connection, delay or swallow acknowledgements, send the same message twice, switch
Halo off) and six scripted scenarios. Switched on with `SIMULATOR_ENABLED=true`.

- **From Halo:** Settings, Channels, Vircle Chat, **Open simulator**. Halo hands the gateway a five-minute,
  single-use link signed with the workspace's signing secret (`src/simulator/token.ts`).
- **On your own machine, no database and no Halo needed:** `npm run sim`, then open http://localhost:8090/launch.
  It uses an in-memory Postgres and a stand-in Halo that checks signatures and remembers event ids.
- Test users are named `... (sim)`, are flagged in the database, and their alerts always go to the mock push
  adapter whatever `PUSH_ADAPTER` is. The simulator can act only on them.

## Deploy

`docs/vircle-chat-gateway-deploy.md` (compose file `docker-compose.gateway.yml`, `gateway/Dockerfile`, the
`chat.vircle.tech` proxy, connecting Halo).

## Connect a Halo workspace

1. In Halo, Settings, Channels, Vircle Chat: connect, enter this gateway's public address, and copy the
   workspace key, the signing secret and the API token (each secret is shown once).
2. On the gateway server:

```
export HALO_SIGNING_SECRET=vcs_...      # from Halo
export HALO_API_TOKEN=vct_...           # from Halo
npm run cli -- create-workspace --key vcw_... --name "Vircle" \
  --halo-url https://<halo-host>/api/vircle-chat/webhook
```

It prints a **sessions key**: give it to the Vircle backend (it uses it to ask for chat sessions). When Halo
rotates a secret, run `update-workspace` with the new value; `rotate-sessions-key` replaces the sessions key.

```
npm run cli -- list-workspaces
npm run cli -- update-workspace --key vcw_... [--halo-url ...] [--name ...]   # secrets via HALO_SIGNING_SECRET / HALO_API_TOKEN
npm run cli -- rotate-sessions-key --key vcw_...
npm run cli -- outbox [--key vcw_...]          # what is waiting for Halo, what was given up on
npm run cli -- retry-failed [--key vcw_...]    # put given-up events back in the queue
```

## HTTP

| Route | Caller | Auth |
| --- | --- | --- |
| `GET /healthz` | anyone (load balancer) | none |
| `POST /v1/sessions` | the Vircle backend: `{ "user": { "wallet_id", "name"?, "phone"?, "email"? } }` gives `{ token, expires_at, ws_path, conversation_id }` | `Authorization: Bearer <sessions key>` |
| `POST /v1/messages` | Halo, one message to a user (contract section 4); needs `Idempotency-Key` | `Authorization: Bearer <Halo API token>` |
| `GET /v1/health` | Halo's "Test connection" | `Authorization: Bearer <Halo API token>` |

The app connects to `wss://<host>/ws` and starts with `hello` using the token from `POST /v1/sessions`.
Frames are documented at the top of `src/protocol.ts`.

## How events reach Halo

Every `message.inbound` and `message.receipt` is written to the `outbox_events` table in the same
transaction as the change it describes, then posted to Halo signed with the workspace's secret. Events go in
order per conversation, and different conversations are sent side by side (`DISPATCH_CONCURRENCY`, default 16); one that Halo does not accept (no answer, 5xx, 429, 401, 404) is retried with growing
waits and holds back the ones behind it in the same conversation; a 400/413/422 is set aside and the rest carry on; after
`DISPATCH_GIVE_UP_HOURS` an event is given up on and kept for `outbox` and `retry-failed`. See the header of
`src/dispatcher.ts`. Run one gateway process: two would not corrupt anything (Halo dedupes event ids) but
could reorder events.

## Real Postgres, load test, operations

`npm test` runs on PGlite (in-process, no install). `npm run test:pg` runs the same suite on a real Postgres 16 through the
`pg` driver (an embedded server, downloaded by npm, no Docker). `npm run loadtest` runs the gateway as a separate process on a real
Postgres with 1,000 pretend phones (`docs/vircle-chat-gateway-loadtest.md`). Day-to-day running, alerts, backup and restore:
`docs/vircle-chat-gateway-runbook.md`.

Still untested: two gateway writers at the same instant from separate processes (the schema's unique indexes protect them), and
anything that needs the server itself (see the runbook, section 9).
