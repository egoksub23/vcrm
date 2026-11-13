# Incident platform: security review (P2.9)

A self-review of the new public surface, written alongside the code. It is not a substitute for an independent review before go-live; it lists what was
checked, what is enforced where, and what is left to verify on UAT.

## Public surface

| Route | Credential | Notes |
| --- | --- | --- |
| `POST /api/public/incident-intake/launch` | Intake key (Bearer) | Server to server. School comes from the key hash only. |
| `GET /api/public/clearances` | Intake key, scope `clearances.read` | Returns dates only: student id, type, date, incident reference. |
| `GET /report/<token>` | Signed link | Server-rendered; roster names and classes only (no guardian contacts). |
| `POST /api/public/incident-report` | Signed link in the body | Files one report per link. |
| `POST /api/public/incident-report/photo` | Signed link in the form | Only after the report is filed, for 30 minutes. |
| `GET /incident-ack/<token>`, `POST /api/public/incident-ack` | Signed per-message token | Shows reference, category, severity only. |

## Keys

* Format `ik_live_` or `ik_test_` plus 43 URL-safe characters (256 bits). Shown once; only the SHA-256 hash is stored (`incident_intake_keys.key_hash`, unique).
* A lookup by hash of a 256-bit random value needs no constant-time compare. Unknown, revoked and wrong-mode keys all answer the same 401.
* Scopes `launch` and `clearances.read`; a missing scope is a 403 with the scope named.
* Rotate (new key, old one keeps working) and revoke (immediate; also ends links the key issued, because the link checks its key on every use).
* Rate limit per key (120/minute, in memory per process: see Open items).
* The key never appears in a response after creation, in a log line, or in the hand-off guide (a test asserts the guide never contains a full key).

## Report links

* Token = base64url(`{ s: sessionId, o: [frame origins] }`) + `.` + 32 characters of HMAC-SHA256 over the payload, keyed by `INCIDENT_INTAKE_SECRET` (falling back to
  `INCIDENT_ACK_SECRET`, `AUTOMATION_CRON_SECRET`, `AUTH_SECRET`). Verified with `timingSafeEqual`. **With no secret configured nothing verifies** (tested).
* Valid 2 hours; files one report; a repeat returns the same reference (`duplicate: true`). Stored sessions are deleted a week after expiry (daily housekeeping).
* The session id is a random UUID; the token is not guessable and cannot be edited (any change breaks the HMAC; tested with a forged payload).
* Idempotent launch returns the same link without storing the token: the token is recomputed from the session.
* Student data never goes into a URL (the roster is in the database row, sent in the launch body), an error message, or the call log (tested).

## Framing and the browser

* `/report/*` gets no `X-Frame-Options` (it cannot name an allowed site). The proxy sets `Content-Security-Policy: frame-ancestors <origins signed into the link>`,
  or `'none'` when none are registered or the token is invalid (tested in `src/proxy-report.test.ts`).
* The proxy skips session handling for `/report/*` and `/incident-ack/*`: no `Set-Cookie`, no session lookup (tested).
* `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`, `nosniff`, HSTS, `Permissions-Policy: camera=(self)` on `/report/*`.
* Messages to the parent page use `postMessage` with each registered origin as the target, never `*`, and carry no names or answers (tested).
* Origins must be `https://host[:port]` (or `http://localhost` for development); no paths, no wildcards.

## Data

* New tables all carry `account_id` with row-level security. Sessions and the message log have **no** client policy (server only). Clearances are read with
  `incidents.medical`. Static tests pin all of this (`migrations-208-211.test.ts`).
* Service-only SQL functions are revoked from `PUBLIC`, `anon` and `authenticated`.
* Roster snapshots hold children's data. They are limited (200 students, 4 guardians each), stored only on the session until it is purged, and copied to the
  incident only for the people actually named. Guardian contact details are used for notices and never sent to the coach's browser.
* Notices are minimal by construction: reference, category, severity, links. A test asserts no names or description appear.
* Retention is the school's choice. Deleting needs two capabilities, an export first, the number typed, and is logged (`incident_retention_log`). Open incidents are never deleted.

## Uploads

* Photos only after the report is filed, within 30 minutes, at most 5, 10 MB each, types JPEG/PNG/WebP/HEIC/PDF checked from the declared type.
* The body size is checked from `Content-Length` before reading.
* Stored under the school's own folder with a generated name; the file's SHA-256 is recorded for the evidence log.

## Open items to verify on UAT

1. The declared MIME type is trusted; add content sniffing (magic bytes) before go-live if the school stores anything beyond photos.
2. Rate limits are per process memory; with more than one app instance a shared limiter (the Postgres one used elsewhere) is better.
3. Send a deliberately bad `X-Forwarded-For`: the per-IP limits trust the first entry, which is right only behind the reverse proxy.
4. Check `frame-ancestors` and the absence of `X-Frame-Options` on the live address with a real iframe, and in the two web views.
5. Confirm `NEXT_PUBLIC_SITE_URL` and the three secrets are set, and that `INCIDENT_ACK_SECRET` differs from the cron secret.
6. Independent penetration test of the public routes before the live key is issued.
