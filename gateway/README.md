# Vircle Chat gateway

The service between the Vircle app and Halo. Scope: `docs/vircle-chat-gateway-scope.md`. Contract with
Halo: `docs/vircle-chat-contract.md`. It is its own package (own `package.json`, tests and tsconfig) and is
not part of Halo's build or its Docker image.

## What is built

| Work package | State |
| --- | --- |
| 1. Storage, sessions, the app WebSocket protocol | done |
| 2. Halo side: `POST /v1/messages`, `GET /v1/health`, signed events with a retrying outbox | done |
| 3. Delivery decision, push adapter and mock | next |
| 4 to 8. Files, client library, simulator, deployment, real push adapter | not started |

Until work package 3, a message from Halo goes to a user's live connection if they have one (`delivery:
"socket"`) and otherwise waits for their next connection (`"queued"`); no push is raised yet. File messages
are refused with `invalid_media` until work package 4.

## Run the tests

```
cd gateway
npm install
npm test            # 136 tests, about 40 seconds; an in-process Postgres (PGlite), no Docker needed
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
`DISPATCH_GIVE_UP_HOURS` (72), `MAX_HALO_BODY_BYTES` (64 KB).

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
order per workspace; one that Halo does not accept (no answer, 5xx, 429, 401, 404) is retried with growing
waits and holds back the ones behind it; a 400/413/422 is set aside and the rest carry on; after
`DISPATCH_GIVE_UP_HOURS` an event is given up on and kept for `outbox` and `retry-failed`. See the header of
`src/dispatcher.ts`. Run one gateway process: two would not corrupt anything (Halo dedupes event ids) but
could reorder events.

## Not yet exercised

The tests use PGlite, which serves one connection at a time, and nothing has run against the `pg` driver or
a real Postgres yet (work package 7 does, with a load test). Two writers at the same instant are therefore
untested; the schema's unique indexes are what protect them.
