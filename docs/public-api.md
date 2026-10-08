# Public API (`/api/v1`)

The public API lets you drive your wacrm instance from your own
scripts and automations — send messages, manage contacts, launch
broadcasts — without going through the dashboard UI.

> **Status:** stable. Authentication, scopes, rate limiting, the
> messages / contacts / conversations / broadcasts / [Secure Sign](#doc-sign-e-signatures) endpoints, and
> outbound event [webhooks](#webhooks) all ship now.

## Authentication

Every request authenticates with an **API key**, sent as a bearer
token:

```
Authorization: Bearer wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Keys are **account-scoped**: a key acts on exactly one account, the
one it was created in. There is no cross-account access.

### Creating a key

In the dashboard: **Settings → API keys → New API key**. Only
**admins and owners** can create keys.

1. Give the key a name (after the integration that will use it).
2. Grant the **scopes** it needs — nothing more (see below).
3. Copy the key. **The full key is shown exactly once.** wacrm
   stores only a SHA-256 hash, so it can never be shown again. If you
   lose it, revoke it and create a new one.

### Revoking a key

**Settings → API keys → Revoke.** Revocation is effective on the
key's next request. Revoked keys stay in the list as an audit trail.

## Scopes

A key can do only what its scopes allow — independent of who created
it. Grant the minimum.

| Scope                | Allows                                   |
| -------------------- | ---------------------------------------- |
| `messages:send`      | Send WhatsApp messages                   |
| `messages:read`      | Read messages and delivery status        |
| `contacts:read`      | List and read contacts                   |
| `contacts:write`     | Create and update contacts               |
| `conversations:read` | List and read conversations              |
| `broadcasts:send`    | Launch broadcast campaigns               |
| `webhooks:manage`    | Register and manage outbound webhooks    |
| `sign:read`          | See Secure Sign templates, documents and their status, and download signed copies |
| `sign:write`         | Send documents for signature, remind signers and cancel documents |

A key with **no scopes** still authenticates and can call
`GET /api/v1/me` — useful for verifying a key works.

## Response envelope

Every response uses one of two shapes:

```jsonc
// success
{ "data": { /* ... */ } }

// failure
{ "error": { "code": "forbidden", "message": "This API key is missing the 'messages:send' scope" } }
```

Branch on `error.code` (stable); `error.message` is for humans and
may be reworded.

| Status | `code`         | Meaning                                          |
| ------ | -------------- | ------------------------------------------------ |
| 401    | `unauthorized` | Missing / malformed / unknown / revoked / expired key |
| 403    | `forbidden`    | Valid key, but missing the required scope        |
| 429    | `rate_limited` | Per-key rate limit exceeded                      |
| 400    | `bad_request`  | Malformed input                                  |
| 404    | `not_found`    | No such resource                                 |
| 500    | `internal`     | Server error                                     |

## Rate limits

Requests are limited **per key**: **120 requests per minute**. On a
`429`, these headers tell you when to retry:

- `Retry-After` — seconds until the window resets
- `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

> The limiter is in-memory and **per process**. A single-instance
> deploy (the common case for a self-hosted fork) is fine as-is. If
> you scale to multiple instances, swap the limiter for a shared
> store (Redis/Upstash) — see the note at the top of
> `src/lib/rate-limit.ts`. The limit is otherwise unenforced across
> instances.

## Endpoints

### `GET /api/v1/me`

Returns the account a key is bound to and the scopes it carries.
Requires only a valid key (no scope). Use it to verify a key works
and to discover its scopes.

```bash
curl https://your-crm.example.com/api/v1/me \
  -H "Authorization: Bearer wacrm_live_xxx"
```

```json
{
  "data": {
    "account": { "id": "…", "name": "Acme Inc" },
    "key": { "id": "…", "scopes": ["messages:send"] }
  }
}
```

### `POST /api/v1/messages`

Send a WhatsApp message to a phone number. Scope: `messages:send`. You
pass an **E.164 number**, not an internal id — the endpoint
finds-or-creates the contact + conversation, then sends.

```bash
curl -X POST https://your-crm.example.com/api/v1/messages \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{ "to": "+14155550123", "type": "text", "text": "Hi 👋" }'
```

`type` is `text` (default), `template`, or a media kind (`image` /
`video` / `document` / `audio`). Media needs `media_url` (and optional
`filename`); `text` doubles as the caption. `template` needs a
`template` object:

```jsonc
{
  "to": "+14155550123",
  "type": "template",
  "template": {
    "name": "order_update",
    "language": "en_US",
    "params": ["A123"]        // positional body vars, or a structured object
  },
  "reply_to_message_id": "<uuid>"   // optional; must be in the same conversation
}
```

Response (201):

```json
{
  "data": {
    "message_id": "…",
    "whatsapp_message_id": "wamid.…",
    "conversation_id": "…",
    "contact_id": "…",
    "contact_created": true
  }
}
```

Domain error codes beyond the table above: `whatsapp_not_configured`
(400), `meta_error` (502 — the request reached Meta and it rejected the
send), `template_malformed` (500).

### `GET /api/v1/contacts`

List contacts, newest first. Scope: `contacts:read`. Paginated (see
[Pagination](#pagination)). Optional filters: `?search=` (matches name
or phone) and `?tag=<tagId>`.

```json
{
  "data": [
    {
      "id": "…", "phone": "+14155550123", "name": "Jane Doe",
      "email": null, "company": "Acme", "avatar_url": null,
      "tags": [{ "id": "…", "name": "vip", "color": "#3b82f6" }],
      "created_at": "…", "updated_at": "…"
    }
  ],
  "meta": { "next_cursor": "…" }
}
```

### `POST /api/v1/contacts`

Create a contact. Scope: `contacts:write`. `phone` (E.164) is required;
`name`, `email`, `company`, and `tags` (an array of tag names, created
if missing) are optional. **Find-or-create by phone:** an existing
match returns `200` with the existing contact; a new contact returns
`201`. The response body is the serialized contact (same shape as the
list rows above).

### `GET` / `PATCH /api/v1/contacts/{id}`

Read or update one contact. Scopes: `contacts:read` / `contacts:write`.
`PATCH` updates only the fields you send (`name`, `email`, `company`);
pass `tags` (an array of tag names) to replace the contact's tags. A
contact in another account returns `404`.

### `GET /api/v1/conversations`

List conversations, newest first. Scope: `conversations:read`.
Paginated. Optional filters: `?status=` (`open` / `pending` / `closed`)
and `?contact_id=`. Each conversation embeds its contact + tags.

### `GET /api/v1/conversations/{id}`

Read one conversation. Scope: `conversations:read`. `404` if it belongs
to another account.

### `GET /api/v1/conversations/{id}/messages`

List a conversation's messages, newest first. Scope: `messages:read`.
Paginated. Each message includes its `direction` (`inbound` /
`outbound`), `status` (delivery state), `whatsapp_message_id`, and
`content_*`. The conversation is verified to belong to your account
first (`404` otherwise).

### `POST /api/v1/broadcasts`

Launch a template broadcast to a list of recipients. Scope:
`broadcasts:send`. The broadcast + its recipient rows are persisted
immediately and the sends fan out in the background, so the call
returns fast — poll `GET /api/v1/broadcasts/{id}` for progress.

```bash
curl -X POST https://your-crm.example.com/api/v1/broadcasts \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "July promo",
        "template_name": "promo_july",
        "template_language": "en_US",
        "recipients": [
          { "to": "+14155550123", "params": ["Jane"] },
          { "to": "+14155550124" }
        ]
      }'
```

Recipients are capped at **1000 per request** — split larger sends.
Invalid phone numbers are dropped and counted as `rejected`. Response
(202):

```json
{
  "data": {
    "broadcast_id": "…",
    "status": "sending",
    "total_recipients": 2,
    "accepted": 2,
    "rejected": 0
  }
}
```

### `GET /api/v1/broadcasts/{id}`

Broadcast status + counts. Scope: `broadcasts:send`. `status` moves
`sending` → `sent`; `delivered_count` / `read_count` keep climbing as
Meta delivery webhooks arrive. `404` for another account's broadcast.

## Secure Sign (e-signatures)

Send documents for electronic signature from your own backend, follow them,
and download the signed copy. Everything is under `/api/v1/sign`. Scopes:
`sign:read` for every `GET`, `sign:write` for every `POST`.

**Before you start.** Secure Sign must be switched on for the workspace (the
platform operator does that). Until it is, every call answers `403` with
`error.code` `sign_disabled`, whatever the key's scopes. A key sees only its
own workspace: a document of another workspace is a `404`, exactly like a
document that does not exist.

| Method and path | Scope | What it does |
| --- | --- | --- |
| `GET /api/v1/sign/templates` | `sign:read` | The templates you can send from, with their role keys and merge keys |
| `POST /api/v1/sign/documents` | `sign:write` | Make a document from a template and (by default) send it, in one call |
| `GET /api/v1/sign/documents` | `sign:read` | List documents (paginated, filters below) |
| `GET /api/v1/sign/documents/{id}` | `sign:read` | One document: status, people, progress, timestamps |
| `POST /api/v1/sign/documents/{id}/send` | `sign:write` | Send a draft made with `send: false` |
| `POST /api/v1/sign/documents/{id}/void` | `sign:write` | Cancel a document that has not finished |
| `POST /api/v1/sign/documents/{id}/remind` | `sign:write` | Remind the people who have not signed |
| `GET /api/v1/sign/documents/{id}/file` | `sign:read` | Download the signed PDF (after completion) |
| `GET /api/v1/sign/documents/{id}/certificate` | `sign:read` | Download the certificate of completion as a PDF of its own (after completion) |

Instead of polling `GET /documents/{id}`, subscribe to the `sign.*` events (see
[Webhooks](#webhooks)).

### `GET /api/v1/sign/templates`

Active templates of the workspace. Use it once to learn what to put in `signers`
and `merge_values`.

```json
{
  "data": [
    {
      "id": "6f1c…",
      "name": "Merchant Application",
      "description": null,
      "category_id": "…",
      "version": 3,
      "page_count": 6,
      "roles": [
        { "key": "merchant", "label": "Merchant", "kind": "signer" },
        { "key": "finance", "label": "Finance contact", "kind": "filler" },
        { "key": "director", "label": "Director (countersign)", "kind": "signer" }
      ],
      "merge_keys": [
        { "key": "fw_no", "label": "FW no.", "required": false }
      ],
      "has_form": true,
      "defaults": { "expiry_days": 14, "sign_in_order": null, "code_required": null, "locale": null }
    }
  ],
  "meta": { "next_cursor": null }
}
```

`roles[].key` is what you put in `signers[].role_key`. A `kind: "filler"` role
completes its part without signing. `merge_keys` are the values the sender
fixes before sending (a reference number, a fee); `required: true` means the
call is refused without it.

### `POST /api/v1/sign/documents`

Makes the document from a template, sets who signs, fills the merge values and,
unless `send` is `false`, sends it. **All or nothing:** if any step fails (a role
that does not exist, a document that is not ready, the monthly limit), nothing is
left behind, so a retry starts clean.

| Field | Type | Notes |
| --- | --- | --- |
| `template_id` | uuid, required | From `GET /templates` |
| `signers` | array, required | 1 to 20 people, see below |
| `reference` | string, optional | **Your idempotency key**, 1 to 64 of letters, digits and `. _ : / # -`. Shown on the document and the certificate as its number. It must not look like `SGN-2026-000123` (the system's own numbering) |
| `title` | string, optional | Up to 200 characters. Default: the template's subject, else its name |
| `contact_id` | uuid, optional | A contact of this workspace, to link the document to. The API does not create contacts |
| `merge_values` | object, optional | `{ "fw_no": "FW-2291" }`. Text, numbers and true/false (written as text), up to 2000 characters each. A key the template does not have is a `400` (it would print nothing) |
| `message` | string, optional | Up to 2000 characters, shown to the signers |
| `locale` | `en`, `ms`, `zh`, `ko`, optional | Language of the messages and the signed copy. Default: the template's, else the workspace's |
| `expires_in_days` | integer 1 to 365, optional | Default: the category's, else the workspace's |
| `sign_in_order` | boolean, optional | Default: the template's |
| `code_required` | boolean, optional | Ask each signer for a one-time code. Default: the template's |
| `copy_to` | array, optional | Up to 10 people who **receive a copy** of the signed document and do not sign, see below |
| `send` | boolean, default `true` | `false` leaves a draft (see `POST .../send`) |

Each entry of `signers`:

| Field | Notes |
| --- | --- |
| `role_key` | Required. A role key of the template |
| `full_name` | Required, up to 160 characters |
| `email` | Required, a valid address |
| `phone` | International number such as `+60123456789` (spaces and dashes are fine). Required for `channel: "whatsapp"` |
| `channel` | `email` (default) or `whatsapp` |
| `order_no` | Whole number from 1. Default: the position in the list. Only matters with `sign_in_order`. People who share a number form one step: they are invited together, and the next step begins when all of them have finished |

Each entry of `copy_to`, people who receive the signed PDF by email when the
document is completed and sealed (the same address-and-name rules as a signer):

| Field | Notes |
| --- | --- |
| `full_name` | Required, up to 160 characters |
| `email` | Required, a valid address, up to 254 characters |

A person in `copy_to` is not a signer: they have no role, no signing link, no
turn in `sign_in_order`, get no reminders, and are never in `signers` or in
`signers_total` / `signers_signed`. A signer's address cannot also be in
`copy_to`, and an address is listed once (compared ignoring case). More than 10
entries, a missing name, a bad address or a duplicate is a `400` `bad_request`
with every problem in `issues`, each naming the entry, for example
`copy_to[0].email` or `copy_to[2].full_name`:

```json
{ "error": { "code": "bad_request", "message": "Some fields are missing or not valid. See `issues`.",
  "issues": [ { "code": "invalid", "field": "copy_to[0].email", "detail": "must be a valid email address" } ] } }
```

The list is saved in the same all-or-nothing call as the document, so nothing is
left behind when the call fails. When the document is completed, each person is
sent one email with the signed PDF attached, and its certificate as a second,
separate attachment (a file too large to attach is not sent as a link: the email
says to ask the sender). Each is sent it once.

Fields it does not know are ignored. Wrong or missing fields give a `400` with
`error.code` `bad_request` and **every** problem in `error.issues`, each naming
the field:

```json
{ "error": { "code": "bad_request", "message": "Some fields are missing or not valid. See `issues`.",
  "issues": [ { "code": "invalid", "field": "signers[0].email", "detail": "must be a valid email address" } ] } }
```

Problems that need the template (a role or merge key that does not exist, a
required merge value missing) are a `400` `invalid_request` with `issues` such as
`unknown_role` (its `detail` lists the valid role keys), `unknown_merge_key` and
`merge_value_missing`. A document that cannot be sent yet (for example a role
with fields but nobody assigned) is a `400` `not_ready` with its `issues`.

```bash
curl -X POST https://your-crm.example.com/api/v1/sign/documents \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "template_id": "6f1c…",
    "reference": "MERCHANT-10231",
    "merge_values": { "fw_no": "FW-2291" },
    "signers": [
      { "role_key": "merchant", "full_name": "Ali bin Ahmad", "email": "ali@kedairuncit.example", "phone": "+60123456789", "channel": "whatsapp" },
      { "role_key": "director", "full_name": "Gokula Krishnan", "email": "gokula@vircle.example", "order_no": 2 }
    ],
    "sign_in_order": true,
    "expires_in_days": 14
  }'
```

`201 Created`, the document (see below) plus `invitations`: for each person, whether
the message reached them. A message that could not be delivered is reported
(`failed`, or `not_configured` when the channel is not set up) and the document is
sent anyway; the signing link is **never** returned by the API. `delivery.detail` says
why: a reason word (`not_set_up`, `mailbox_reconnect`, `mailbox_paused`, `daily_limit`,
`rate_limited`, `address_rejected`, `attachment_too_large`, `service_unavailable`), then
`: ` and what the mail service said; or only what the service said when the failure is not
one of those. Email goes through the workspace's connected Microsoft 365 or Gmail mailbox
when it has one, otherwise through the platform sender. Call
`POST .../remind` to send a fresh link later.

```json
{
  "data": {
    "id": "0d9e…", "reference": "MERCHANT-10231", "title": "Merchant Application",
    "status": "sent", "template_id": "6f1c…", "contact_id": null, "locale": "en",
    "sign_in_order": true, "code_required": false, "page_count": 6,
    "created_at": "2026-10-07T01:00:00.000Z", "updated_at": "2026-10-07T01:00:02.000Z",
    "sent_at": "2026-10-07T01:00:02.000Z", "expires_at": "2026-10-21T01:00:02.000Z",
    "completed_at": null, "void_reason": null,
    "cancelled": false, "cancelled_at": null, "cancelled_by": null, "cancel_reason": null,
    "final_sha256": null, "certificate_sha256": null, "verify_url": null,
    "signers": [
      { "id": "…", "role_key": "merchant", "kind": "signer", "full_name": "Ali bin Ahmad",
        "email": "ali@kedairuncit.example", "channel": "whatsapp", "order_no": 1,
        "status": "sent", "invited_at": "2026-10-07T01:00:02.000Z", "viewed_at": null,
        "signed_at": null, "declined_at": null, "decline_reason": null,
        "last_reminded_at": null, "reminder_count": 0 }
    ],
    "copy_to": [ { "full_name": "Siti Accounts" } ],
    "invitations": [ { "signer_id": "…", "role_key": "merchant", "channel": "whatsapp", "status": "sent" } ]
  }
}
```

#### Idempotency

Send the same `reference` again (a retry after a timeout, a job that ran twice)
and you get **the same document back, never a second one**: `200` (not `201`),
the header `Idempotent-Replay: true`, no `invitations`, and nothing is sent again.
The first call decides what the document is: a retry's other fields are ignored.
Two exceptions: a reference used for a document made from a *different*
template is a `409` `reference_conflict`; and two calls at the very same moment
leave one of them to find the other's document (or a `409` `reference_in_use`
you can simply retry). Without a `reference` there is no idempotency: every call
makes a new document.

If a call with `send: false` was replayed, you get the draft (`status: "draft"`),
not a send. Use `POST .../send`.

The replay returns the document as it was made, `copy_to` included: the same list
of names, in the same order. `copy_to` in a retry is ignored like every other
field, so a retry never adds a person.

### `GET /api/v1/sign/documents`

Newest first, paginated like every list ([Pagination](#pagination)). Filters:
`status` (`draft`, `sent`, `in_progress`, `sealing`, `completed`, `declined`,
`expired`, `voided`, `failed`), `contact_id`, `template_id`, `reference`
(exact), `created_after` (a date or an ISO 8601 time), and `cancelled`
(`true` for only the completed documents that were cancelled afterwards, `false`
for only the ones that were not; leave it out for both). A cancelled document is
still `completed`, so `status=completed&cancelled=false` is "completed and in
force". A filter that is not valid is a `400`. Each row has the same facts as
the single document, without the people, plus `signers_total` and
`signers_signed`.

Documents a person sent themselves from a template page to try it out (**test documents**, marked TEST on every page) are not listed, and the API never creates one.

**Private documents** (a person who uploads a document or a document collection in Halo can keep it to themselves, the workspace's admins and the Halo users named as signers) are never listed and never opened by a key: `GET /documents/{id}`, the file, send, void and remind answer `404 document_not_found` for one, exactly as for an id that does not exist. A key belongs to an integration, not to a person, so it cannot be named on a document. Documents the API creates are never private.

```bash
curl "https://your-crm.example.com/api/v1/sign/documents?status=completed&created_after=2026-10-01&limit=50" \
  -H "Authorization: Bearer wacrm_live_xxx"
```

### `GET /api/v1/sign/documents/{id}`

The document with its people. What the fields mean:

- `status`: `draft`, `sent` (waiting, nobody has signed), `in_progress` (some
  have), `sealing` (everyone signed; the signed copy is being made, usually
  seconds), `completed`, `declined`, `expired`, `voided`, `failed` (sealing
  failed and is retried by itself).
- `mode`: `sign` (an agreement) or `form` (a form without a signature: the
  people fill it in and submit, nothing is signed). It comes from the template
  and never changes. For a form, `signers[].signed_at` is when the person
  submitted, `status` `completed` means everyone has submitted, and the "signed
  copy" (`GET .../file?kind=signed`) is the sealed submission record, with the
  same `final_sha256` and `verify_url`. The answers are not in the JSON; they are in the record file (every answer except the ones the form marks sensitive, which are masked).
- `envelope_id`: the id of the document collection the document is signed in
  (several documents sent to the same people as one, migration 171), or `null`.
  The field keeps this name as part of the API contract. Read only: the API does
  not create or change document collections yet, and a document of a collection
  cannot be sent, cancelled, reminded or have its people changed through the API
  (the call answers `document_in_envelope`); that is done on the collection in
  Halo.
- `copy_to`: the people who receive the signed copy, `[{ "full_name": "…" }]` in the
  order they were added. **Names only:** the addresses are never returned. Empty
  when there are none, and always empty for a document of a collection (a
  collection's copy recipients belong to the collection). They are not signers.
- `signers[].status`: `pending` (not invited yet: signing order), `sent`
  (invited), `viewed`, `signed`, `declined` (with `decline_reason`). `signed_at`
  is when they signed.
- `cancelled`, `cancelled_at`, `cancelled_by` and `cancel_reason`: a person in
  Halo (the one who sent the document, or an admin) can cancel a document
  **after** it is completed, with a reason. The document stays `completed` and
  sealed: its signed file, its certificate and its history are exactly as they
  were, and `final_sha256`, `certificate_sha256` and `verify_url` are still
  there (the public verify page keeps saying the file is genuine and adds that
  it was cancelled on that date). `cancelled` is `true` once that has happened;
  `cancelled_at` is when, `cancelled_by` is the id of the person who did it
  (`null` if their login was deleted; never a name or address) and
  `cancel_reason` is what they typed (3 to 500 characters). All four are
  `cancelled: false` and `null` otherwise. A cancelled document is no longer in
  force, but nothing about it is deleted. The API cannot cancel a completed
  document; it is done in Halo, and `sign.cancelled` tells your backend. (A
  document of a collection is cancelled with its collection: every document in it
  gets the same four fields.)
- `final_sha256`, `certificate_sha256` and `verify_url` appear once `completed`.
  `final_sha256` is the SHA-256 of the signed PDF, so you can check what you
  downloaded. `certificate_sha256` is the SHA-256 of the certificate PDF (see
  `GET .../certificate` below); it is `null` for a document that was sealed before
  certificates became separate files, whose certificate is the last pages of the
  signed PDF. `verify_url` is the public page behind the QR code on the
  certificate: anyone can open it and check either file against its fingerprint.
- `progress` is `null` for a document without a form. For a document with a form
  (such as Merchant Registration) it lists, for each role, `percent` of required
  answers given, `last_activity_at` and `parts`: `{ key, title, state, done,
  total }` with `state` `not_started`, `in_progress` or `done`. The answers
  themselves are not in the API.

Never in any response: a signing link or token, the code sent to a signer, IP
addresses, device details, storage paths, or the merge values.

### `POST /api/v1/sign/documents/{id}/send`

Sends a draft made with `send: false`. The monthly limit of the workspace
applies: `429` `sign_limit_reached`. A document that was already sent is a `409`
`document_not_draft`. Answer: the document with `invitations`.

### `POST /api/v1/sign/documents/{id}/void`

Body `{ "reason": "Wrong fee" }` (required, kept in the document's history). Every
link then shows the document was cancelled, and people who were waiting are told.
Cancelling a document that is already cancelled answers `200` unchanged (a retry
is harmless). A document that completed, expired, was declined, is being sealed or
failed is a `409` `document_not_open`.

### `POST /api/v1/sign/documents/{id}/remind`

Body `{ "signer_id": "…" }` for one person, or an empty body for everyone who is
waiting. The rule is the one on the screen: **a person is not reminded again within
24 hours**. For one person that is a `409` `remind_too_soon` (the message says when
to try again); for everyone, those held are left out and listed:

```json
{ "data": {
  "invitations": [ { "signer_id": "…", "role_key": "director", "channel": "email", "status": "sent" } ],
  "held": [ { "signer_id": "…", "retry_at": "2026-10-08T03:12:00.000Z" } ]
} }
```

Each reminder carries a **fresh link and the earlier one stops working**. A
document that is not waiting is a `409` `document_not_open`; nobody to remind is a
`409` `nobody_to_remind`; a person who has signed, declined or was not invited
yet is `signer_not_open`.

### `GET /api/v1/sign/documents/{id}/file?kind=signed`

Downloads the file as an attachment (`Content-Disposition: attachment`), with the
header `X-Content-SHA256` (the same as `final_sha256`). The API hands out bytes
and never an address, so the file cannot be shared by link; every download is
authenticated and recorded in the document's history.

- `kind=signed` (the default): the sealed PDF. A document sealed now has the
  signatures and a small grey line on every page, `Vircle Secure Sign · ID <document id>`
  (for a document of a collection, `Vircle Secure Sign · COL-… · ID <document id>`);
  its certificate is a file of its own (next). A document sealed earlier has its
  certificate pages at the end of this PDF. **Only once the document is `completed`**;
  before that it is a `409` `not_completed`, in every state.
- `kind=certificate`: the same file as `GET .../certificate` below. For a document
  sealed before certificates became separate files it answers `404`
  `no_separate_certificate` (its certificate is the last pages of the signed PDF:
  download `signed`).
- `kind=original`: the file as it was uploaded, when the document has one
  (documents made from a template have none: `404` `no_original_file`).

```bash
curl -L -o MERCHANT-10231-signed.pdf \
  "https://your-crm.example.com/api/v1/sign/documents/0d9e…/file?kind=signed" \
  -H "Authorization: Bearer wacrm_live_xxx"
```

### `GET /api/v1/sign/documents/{id}/certificate`

The certificate of completion as a PDF of its own: who signed and when, the timeline of
what happened, the document's reference and id, a QR code to the verify page, and the
SHA-256 of the signed PDF it covers (for a document of a collection also the
collection's reference and how many documents it holds). It is sealed with the same
digital signature as the signed PDF. The answer is the file as an attachment, with
`X-Content-SHA256` (the same as `certificate_sha256` on the document); nothing about
its address is handed out, and every download is recorded in the document's history.

- `409` `not_completed` before the document is `completed`.
- `404` `no_separate_certificate` for a document sealed before certificates became
  separate files: its certificate is the last pages of the signed PDF (`file?kind=signed`).
- The same private-document and workspace rules as the signed file: a document a key
  may not see is a `404` `document_not_found`.

```bash
curl -L -o MERCHANT-10231-certificate.pdf \
  "https://your-crm.example.com/api/v1/sign/documents/0d9e…/certificate" \
  -H "Authorization: Bearer wacrm_live_xxx"
```

### Errors

Secure Sign errors use the usual `{ "error": { "code", "message" } }` envelope; `issues`
is added when there are several things to say. Branch on `code`.

| Status | `code` | Meaning |
| --- | --- | --- |
| 401 | `unauthorized` | Missing, wrong, revoked or expired key |
| 403 | `forbidden` | The key lacks `sign:read` or `sign:write` |
| 403 | `sign_disabled` | Secure Sign is not turned on for the workspace |
| 429 | `rate_limited` | Too many requests. Calls that send messages (create, send, remind) are limited to 30 a minute per key |
| 429 | `sign_limit_reached` | The workspace's monthly limit of documents for signature is reached |
| 400 | `bad_json`, `bad_request`, `invalid_request`, `not_ready` | The body or the filters are not valid; read `issues` |
| 400 | `contact_not_found` | `contact_id` is not a contact of this workspace |
| 400 | `reason_required` | `void` without a reason |
| 404 | `document_not_found` | No such document in this workspace (also for an id that is not a UUID) |
| 404 | `template_not_found`, `signer_not_found` | Not in this workspace / not on this document |
| 404 | `no_separate_certificate`, `no_original_file`, `no_final_file` | The file asked for does not exist (`no_separate_certificate`: the document was sealed before certificates became separate files) |
| 409 | `document_not_draft` | The document was already sent |
| 409 | `document_not_open` | The document is no longer waiting for signatures |
| 409 | `template_not_active` | The template is archived or a draft |
| 409 | `not_completed` | The signed copy exists only after completion |
| 409 | `remind_too_soon`, `nobody_to_remind`, `signer_not_open` | See remind |
| 409 | `reference_conflict`, `reference_in_use` | See idempotency |
| 413 | `body_too_large` | The request body is over 200 KB |
| 500 | `internal`, `database_error` | Something went wrong on our side; retry, and tell us if it persists |

### Example: a merchant onboarding backend

When a merchant is approved in your system, send the Merchant Registration
document, then store the signed copy when it completes. The `reference` is your
own merchant record, so a retried job can never send the merchant a second
document.

```js
const BASE = "https://your-crm.example.com/api/v1/sign";
const headers = { Authorization: `Bearer ${process.env.HALO_API_KEY}`, "Content-Type": "application/json" };

async function sendRegistration(merchant) {
  const res = await fetch(`${BASE}/documents`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      template_id: process.env.HALO_MERCHANT_TEMPLATE_ID,
      reference: `MERCHANT-${merchant.id}`, // idempotency: one document per merchant
      locale: merchant.language ?? "ms",
      signers: [
        { role_key: "merchant", full_name: merchant.ownerName, email: merchant.email, phone: merchant.phone, channel: "whatsapp" },
        { role_key: "director", full_name: "Gokula Krishnan", email: "gokula@vircle.example", order_no: 2 },
      ],
      sign_in_order: true,
    }),
  });
  const { data, error } = await res.json();
  if (!res.ok) throw new Error(`${error.code}: ${error.message}`); // 429 and 5xx are safe to retry
  return { documentId: data.id, replay: res.headers.get("Idempotent-Replay") === "true" };
}

// Call this from your sign.completed webhook handler (or poll GET /documents/{id}).
async function saveSignedCopy(documentId, merchant) {
  const res = await fetch(`${BASE}/documents/${documentId}/file?kind=signed`, { headers });
  if (res.status === 409) return; // not completed yet
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const pdf = Buffer.from(await res.arrayBuffer());
  const expected = res.headers.get("X-Content-SHA256"); // compare with your own SHA-256 if you like
  await store(`merchants/${merchant.id}/registration-signed.pdf`, pdf, expected);
}
```

## Pagination

Every list endpoint pages the same way. Request a page size with
`?limit=` (default 50, max 100) and read the next page with the opaque
`meta.next_cursor` from the previous response:

```
GET /api/v1/contacts?limit=50
→ { "data": [ … ], "meta": { "next_cursor": "eyJ…" } }

GET /api/v1/contacts?limit=50&cursor=eyJ…
→ { "data": [ … ], "meta": { "next_cursor": null } }   // last page
```

Cursors are keyset-based (stable under concurrent inserts). Pass the
cursor back verbatim — don't parse it. `next_cursor: null` means the
last page.

## Webhooks

Rather than polling, register an endpoint and wacrm will POST to it when
things happen in your account. **Migration required:** apply
`supabase/migrations/028_webhook_endpoints.sql`.

### Events

| Event                    | Fires when                                        |
| ------------------------ | ------------------------------------------------- |
| `message.received`       | An inbound message arrives from a contact         |
| `message.status_updated` | A message you sent changed delivery status        |
| `conversation.created`   | A new conversation is opened for a contact        |
| `sign.sent`              | A Secure Sign document was sent for signing          |
| `sign.viewed`            | A signer opened their link for the first time     |
| `sign.completed`         | Everyone signed and the sealed file is ready      |
| `sign.declined`          | A signer declined                                 |
| `sign.expired`           | A document passed its expiry date unsigned        |
| `sign.voided`            | The sender cancelled a document                   |
| `sign.cancelled`         | A completed document was cancelled afterwards     |

The `sign.*` events are emitted only for workspaces that have Secure Sign
switched on. See [Secure Sign events](#doc-sign-events) for their payload.

### Managing endpoints

All under scope `webhooks:manage`.

- `POST /api/v1/webhooks` — register `{ "url": "https://…", "events": ["message.received"] }`. `url` must be `https://`. **The response includes `secret` exactly once** — store it to verify signatures; wacrm keeps only an encrypted copy.
- `GET /api/v1/webhooks` — list your endpoints (never returns the secret).
- `GET /api/v1/webhooks/{id}` — read one.
- `PATCH /api/v1/webhooks/{id}` — update `url`, `events`, or `is_active` (re-enabling clears the failure counter).
- `DELETE /api/v1/webhooks/{id}` — remove one.

```bash
curl -X POST https://your-crm.example.com/api/v1/webhooks \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://example.com/hooks/wacrm", "events": ["message.received"] }'
# → 201 { "data": { "id": "…", "url": "…", "events": [...], "secret": "whsec_…" } }
```

### Delivery payload

Every delivery is a POST with this envelope; `id` is a unique per-
delivery uuid you can dedupe on, and `data` varies by `event`:

```json
{
  "id": "8f3c…",
  "event": "message.received",
  "occurred_at": "2026-07-01T12:00:00.000Z",
  "account_id": "…",
  "data": { /* per-event, see below */ }
}
```

`data` by event:

```jsonc
// message.received
{ "conversation_id": "…", "contact_id": "…", "whatsapp_message_id": "wamid.…", "content_type": "text", "text": "Hi 👋" }
// conversation.created
{ "conversation_id": "…", "contact_id": "…" }
// message.status_updated
{ "whatsapp_message_id": "wamid.…", "conversation_id": "…", "status": "delivered" }
```

Headers: `X-Wacrm-Event`, `X-Wacrm-Webhook-Id`, and `X-Wacrm-Signature`.

### Secure Sign events

`sign.sent`, `sign.viewed`, `sign.completed`, `sign.declined`, `sign.expired`,
`sign.voided` and `sign.cancelled` share one `data` shape. They are sent after the change is
saved, so `status` is the document's status **after** the event.

```jsonc
// sign.completed
{
  "document_id": "…",
  "reference": "SGN-2026-000123",
  "title": "Merchant Application: Kedai Runcit",
  "status": "completed",
  "mode": "sign",                // "form" for a form without a signature: signers[].signed_at is when they submitted
  "template_id": "…",            // null when the document was not made from a template
  "template_name": "Merchant Application",
  "category_id": "…",            // null when it has none
  "category": "Merchant agreements",
  "contact_id": "…",             // null when it is not linked to a contact
  "created_at": "2026-10-01T02:00:00.000Z",
  "sent_at": "2026-10-02T03:10:00.000Z",
  "completed_at": "2026-10-05T08:01:00.000Z",
  "signers": [
    { "name": "Ali bin Ahmad", "role": "Merchant", "role_key": "merchant", "status": "signed", "signed_at": "2026-10-04T06:03:00.000Z" }
  ],
  "final_sha256": "ab12…",       // completed only: SHA-256 of the sealed PDF
  "certificate_sha256": "cd34…", // completed only, and only when the certificate is a file of its own (GET /api/v1/sign/documents/{id}/certificate); absent for a document sealed earlier
  "verify_url": "https://halo.example/verify/<document_id>" // completed only: public page that proves the file
}
```

- `sign.viewed` and `sign.declined` add `"signer": { "name": "…", "role": "…" }`,
  who it was. `viewed` is sent once per signer, the first time they open
  their link.
- `sign.cancelled` is sent when a person in Halo cancels a **completed**
  document (or a whole document collection: one event for each of its documents,
  each with its `envelope_id`). `status` is still `"completed"`: cancelling does
  not change the sealed record. It carries `final_sha256`, `certificate_sha256`
  and `verify_url` as `sign.completed` did, and adds
  `"cancelled_at": "2026-10-08T02:00:00.000Z"`. Who cancelled and why are not in
  the event (see below); read them with `GET /api/v1/sign/documents/{id}`
  (`cancelled_by`, `cancel_reason`). It was not sent for documents cancelled
  before this event existed.
- **Never included:** email addresses, phone numbers, signing-link tokens,
  file addresses or downloads, IP addresses, merge values, and the reason a
  signer gave when declining, the sender gave when cancelling (voiding), or the
  person gave when cancelling a completed document, and who that was. Download
  the signed file with `GET /api/v1/sign/documents/{id}/file` (see "Secure Sign"
  above) when you need it.
- To check a signed file you hold, compare its SHA-256 with `final_sha256` (the
  certificate's with `certificate_sha256`), or open `verify_url` and drop the file
  on it: the page tells you whether it is the signed document or its certificate.
- Delivery is the same single attempt described below: a receiver that is
  down misses the event. Dedupe on the envelope `id`, and reconcile with the
  Secure Sign API when it matters.

### Verifying the signature

`X-Wacrm-Signature: t=<unix_seconds>,v1=<hex>` where `v1 =
HMAC-SHA256(secret, "${t}.${rawBody}")`. Recompute it over the **raw
request body** and compare in constant time; reject if `t` is more than
a few minutes old (replay protection).

```js
const [, t, v1] = header.match(/t=(\d+),v1=([0-9a-f]+)/);
const expected = crypto.createHmac('sha256', secret)
  .update(`${t}.${rawBody}`).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
```

### Delivery semantics

Delivery is **best-effort**: a single attempt per event with a short
timeout, and **redirects are not followed**. `message.status_updated`
covers messages wacrm stores (inbox + API sends), not broadcast-only
sends, and — because providers re-send and re-order status callbacks —
the same status may arrive more than once or out of order; **dedupe on
`id` and don't assume ordering**. Each consecutive failure increments
`failure_count`; after enough consecutive failures the endpoint is
auto-disabled (`is_active: false`) — re-enable it with `PATCH` (which
resets the counter). Durable retry-with-backoff (a delivery queue) is a
future enhancement; today, treat missed deliveries as possible and
reconcile with the read endpoints when it matters.

**Target restrictions (SSRF).** The `url` must be `https://` and must
resolve to a public address — requests to `localhost`, private/RFC1918
ranges, link-local (incl. cloud metadata `169.254.169.254`), and similar
internal targets are refused at delivery time.

## Roadmap

The public API now covers messaging, contacts, conversations,
broadcasts, and outbound webhooks — the full scope of
[#245](https://github.com/ArnasDon/wacrm/issues/245). Future ideas
(deals/pipelines, templates, flows, a delivery queue for webhooks) are
not yet scheduled.
