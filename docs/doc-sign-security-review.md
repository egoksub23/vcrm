# Doc Sign phases 2 and 3: security review (WP25)

Scope: everything added since Doc Sign 0.77.0, on branch `doc-sign-phase2` (migrations 162 to 171, not applied anywhere). Method: read the
code and the SQL as an attacker, try each attack by reasoning and, where a test could be written, with a test that makes the request. The
database was only read: nothing here was run against Supabase, and no live server was touched.

Reviewer's summary: no critical finding. One high finding (F20, an availability attack found by the sealing benchmark) and five medium findings (F1, F2, F3, F4, F19) were fixed in
code with tests, four low ones were fixed, and one medium finding is a design decision that was not changed (F8). The SQL has no hole that needed a new migration, so there is no
`172_sign_security_fixes.sql` and no `verify-172` script.

## 1. What was reviewed

| Surface | What was read | Result |
|---|---|---|
| 1. Public registration | `src/app/r/[slug]/**`, `POST /api/sign/register/[slug]`, `lib/sign/registration/**`, `service/registration*.ts`, migration 164, `lib/net/client-ip.ts`, Turnstile check | F1, F2, F4 fixed; F10, F11, F12 reported |
| 2. Public API | `app/api/v1/sign/**`, `lib/api/v1/sign.ts`, `service/api.ts`, `service/outbound.ts` | No finding. Scope, workspace scoping, reference idempotency, no token/link/phone/IP/answers in any resource, file only after completion, sign flag, rate limits all hold and are already tested (`sign-api.test.ts`) |
| 3. Signer routes | forward, envelope finish, upload, answers, review, countersign, `lookupByToken`, `pickDocument`, `publicLink`, `scopeOf` | F3, F5, F6 fixed; F9 reported |
| 4. Staff surfaces | bulk (service, routes, CSV parse, SQL claim/lease), exports and zip, sensitive reveal, option lists, test mode, replace file, add-on update | F7 fixed; F8 reported; CSV guard, zip names, lease, workspace scoping hold |
| 5. Outbound | webhook payload, automation step `send_sign_document`, loop guard, SSRF | No finding. Payload carries no email, phone, token, IP, answers or path (test in `outbound.test.ts`); creating or keeping an automation with a send step needs `sign.send` on create and on update; the only new outbound fetch is Turnstile to one fixed address through `pinnedFetch` |
| 6. Database | migrations 162 to 171, every new function's GRANT/REVOKE, RLS, retention exception, sensitive-answers guard, envelope functions | No hole that needs SQL. See section 4 |
| 7. Verify page | `app/verify/[id]/**`, `service/verify.ts` | No finding beyond what the page is designed to show (F14) |
| 8. Logging and errors | every `console.*` in the Doc Sign code, `raiseDatabaseError`, audit `detail` | No secret, token or sensitive value is logged; F13 (PII in a database error message) reported |

## 2. Findings

Severity: critical, high, medium, low, info. "Fixed" means changed in code with a regression test; the test file is named.

### Fixed

**F1 (medium) Registration: one person's address can be mailed from many pages.**
A stranger types a victim's email on a public registration page and Halo emails the victim a document link and starts the workspace's tag
automations. The per-address (5 an hour), per-form (60 an hour) and repeat-in-24-hours limits all follow the attacker's address or one form,
so a script with many addresses, or many registration pages, could still send one victim many messages.
Fix: a limit keyed by the keyed hash of the email alone, 6 valid submissions a day across every form of every workspace
(`RATE_LIMITS.signRegisterEmail`, checked in `submitRegistration` before anything is made). The key carries neither the form, the workspace nor the address.
Test: `registration.test.ts`, "one person's address cannot be mailed from many pages".
Residual: an attacker can still make one workspace's form mail a victim once a day per form, with text the attacker typed (F12). Turnstile on
the page (two environment variables) is the control for that.

**F2 (medium) Registration: the daily cap can be exceeded by a burst.**
The cap counts settled acceptances. A submission is recorded "in progress" first and settled later, so posts that arrive together all read "one
place left" and all pass. Fix: the claims that are still in progress and began earlier (the same order the repeat check uses) count against the cap.
Test: `registration.test.ts`, "counts the claims that are still being handled" and "does not let a claim that began later, or one that died long ago, hold a place".

**F3 (medium) Countersign: a sender can sign as someone else, without that person's mailbox.**
`POST /api/sign/documents/[id]/countersign` replaces the emailed link and code with the Halo sign-in. The signer row is found by the caller's own
user id (so nobody can open someone else's row), but the row's name, email and `internal_user_id` are chosen by whoever sent the document, and
`setSigners` only checks that the user belongs to the workspace. A person with `sign.send` and `sign.sign` could name themselves as "Mr Client,
client@bigcorp.example", send, then open that place from Halo and sign it, without the code and without ever holding the client's mailbox. The
certificate would show the client's name and email with the method "halo_login".
Fix: `openCountersign` opens only a place addressed to the caller's own address (their profile address, the sign-in address, or the same mailbox
with a `+tag`, the rule the template test mode already uses). Otherwise 403 `countersign_other_address`. A person whose place is addressed to another
mailbox uses the emailed link, as before.
Test: `countersign.test.ts`, "refuses a place that is addressed to someone else's email" and the three tests after it.
Open point: the page words an unknown code with its generic sentence. A translated sentence needs an i18n key and the code added to
`COUNTERSIGN_ERROR_CODES` (`lib/sign/client/countersign.ts`) together; messages were not edited here.

**F4 (medium) Registration: the emailed link could be built from the Host header.**
`registrationEnv` took the origin from `originOf(request)`, which is `NEXT_PUBLIC_SITE_URL` when set and the request's own address when not. The
route has no login, so on a deployment without that variable (or reachable under an arbitrary Host) a caller chose the address on the link that a
stranger's email carries, and the link carries the signing token. Fix: the registration route uses `publicOrigin()` only and answers "not available"
(503 `unavailable`) when it is empty. Production sets `NEXT_PUBLIC_SITE_URL` (doc-sign-setup.md), so this only closes the misconfigured case.
Test: `registration.test.ts`, "cannot take submissions when the deployment has no public address of its own".
Not changed: the signer-side routes (forward) still use `originOf(request)`; the caller there already holds a signing link (F18).

**F5 (low, functional) Countersign of a document in an envelope opened a dead link.**
For a person's second document of an envelope the link was made for a row that is not the person's anchor; `loadParty` refuses such a row, so the
link opened nothing, and the session cookie was for the wrong row. Fix: for a row of an envelope the link is rotated through
`sign_envelope_rotate_token` for the anchor, and the session is made for the anchor.
Test: `countersign.test.ts`, "for a person of an envelope rotates the link of the person's first document...".

**F6 (low) Public routes asked the document's own code flag, not the link's.**
Upload, forward, answers, complete, consent, decline and review asked `lookup.doc.code_required`; the page and the finish route ask
`codeRequiredFor(lookup)` (any document of an envelope). The two agree today because `sign_send_envelope` refuses an envelope whose documents
differ, so this is hardening, not an open door. Fix: every public route asks `codeRequiredFor(lookup)`.
Test: `security-review.test.ts`, "is the question every public signer route asks" (scans the route sources) and "is asked for on every document".

**F7 (low) Option list CSV export let a formula that starts like a number through.**
`csvCell` skipped its guard for any text starting with a digit after `+` or `-`, so `-2+3+cmd|' /C calc'!A0` was written as it was. Fix: only a
plain number is left alone; `\t` and `\r` leads are guarded too (the export of documents already did, through `lib/csv.ts`).
Test: `security-review.test.ts`, "a spreadsheet formula that starts like a number".

**F19 (medium) A request body was read whole, so a chunked body could fill the server's memory.**
`readJson`, `readUpload` and the API's `readApiJson` checked the declared `Content-Length` and then called `request.text()` or `request.formData()`. A body
sent chunked declares no length, and one can lie about it, so the check did not stop it. The registration route (`POST /api/sign/register/[slug]`) has no login and
reads its body before it looks the slug up, so anyone could send it a body of any size. On a 1 GB server that is an out-of-memory crash, unless the proxy
caps bodies first (the nginx file for Halo is not in the repository, so that could not be checked; `client_max_body_size` is the control to confirm).
Fix: `lib/net/read-capped.ts` reads the stream a piece at a time and cancels it the moment the total passes the cap (the cap in bytes: four times the character cap
for JSON, the byte cap for uploads). All three readers use it.
Tests: `lib/net/read-capped.test.ts` (an endless stream is stopped after a few pieces) and `security-review.test.ts`, "a body that is bigger than it says".
Not changed: about 140 other route files of the app (outside Doc Sign) call `request.json()` directly and have the same exposure; the proxy's body cap is what covers them. A shared helper for them is a follow-up.

**F20 (high, availability) A signer's long answers could hold the whole server for minutes.**
Found by the sealing benchmark (`docs/doc-sign-load-notes.md`). To put an answer in a multi-line field the engine tried every font size from 14 pt down to 5 pt
and, at each, wrapped the whole answer, measuring every line with full font shaping; then it cut. A multi-line answer may be 2000 characters and a document may have 300
fields. Fifty 2000-character answers in small boxes held the Node process for 135 seconds on a fast developer machine (roughly 400 seconds on the assumed VPS), with
every web request on that process waiting. It runs at sealing (the cron tick, which also runs inside the web process) and, for form-bound answers, at the signer's
"Finish" (`fitProblems`). Anyone who can have a document with small multi-line fields completed (a signer of a document sent by anyone, or a member of a workspace that has
Doc Sign sending to themselves) could do it again every minute, so every tenant of the server was exposed. Doc Sign is switched on per workspace by the operator,
which limits who can try.
Fix (`pdf/format.ts`, `pdf/stamp.ts`): a line wrap stops at the number of lines the box holds; an answer that clearly cannot fit even at 5 pt is cut at once; widths are shaped once per
string and scaled by size; the single-line cut halves instead of dropping a character at a time. Measured again on the same machine: 135 s to 3.7 s (2000 characters), 20.7 s to 6.5 s (330 characters).
Tests: `pdf/engine-limits.test.ts` (the work no longer follows the answer's length; the lines are exactly the first lines of the unbounded wrap).
Residual (medium): an answer that nearly fits still takes the ordinary search, about 0.1 s each; 300 such answers hold the process about 30 s (90 s on the VPS). The real remedy is to seal
in a worker or a separate process (recommendation 5 in the load notes); not done here.

**F21 (low) A 199 or 200 page document could be sent but never sealed.**
The certificate pages made the file longer than the 200-page limit the engine applies when it opens a file, so every attempt failed and the document ended as failed after five tries.
Fix: `sealPdf` opens the file with room for the pages the engine adds (`SEAL_EXTRA_PAGES`). Test: `pdf/engine-limits.test.ts` seals a 200-page document, and a 260-page file is still refused.

### Reported, not changed

**F8 (medium, design) Sensitive answers: "Reveal" needs `sign.send`, the file does not.**
A sensitive answer is stored encrypted, shown masked on the sender's screens, and revealed through a route that needs `sign.send`, is rate limited,
and writes `sensitive_viewed` before it answers. But the sealed PDF prints a sensitive answer in full unless the form says `printMasked`, and the
sealed PDF is served at `menu.sign` (the document file route, the zip, and the API's `kind=signed` for any key with `sign:read`); the files a
signer uploaded (ID cards) are served at `menu.sign` too. Anyone who can open the list can read every sensitive value by downloading the signed copy,
without a reveal event. Why it was not changed: it moves who can download documents (an owner decision, see the comment in the sensitive route) and
it would have to cover uploads and the API to mean anything. Recommended: print sensitive fields masked by default (`printMasked: "last4"`), or let the
signed copy of a document that has a sensitive field printed in full be downloaded with `sign.send` only. Decision needed.

**F9 (low) The signer's review shows every role's printed answers.**
`GET .../review` returns the answers as they will print, from all roles, including another role's sensitive answer when it is printed in full, and
before that role has signed. A delegate is refused. This matches what every signer receives in the sealed copy, so nothing is revealed that the
completed document would not reveal, but it is earlier, and it contradicts the comment in `form-state.ts` that another role's sensitive answer is never
sent. If F8 is decided, apply the same rule here.

**F10 (low) The registration token is not single use.**
It is signed, bound to its form, 3 seconds to 2 hours old, and a replay is bounded by the same limits as a first use. It is a speed bump, as the
code says. A script that loads the page once can post many times until the limits stop it. Turnstile (a token Cloudflare accepts once) closes it.

**F11 (low) At the workspace's contact limit the page tells a known email from a new one.**
An existing contact is found and the document goes out (200); a new email cannot be added (503 `try_later`). Only when the workspace is at its
contact limit. Not fixed: closing it means not telling the visitor, which makes the failure invisible to the person.

**F12 (info) Emails carry text a stranger typed.**
Name, company and email are cleaned (one line, no `<` or `>`, length caps), escaped in the HTML, and kept out of headers. The subject and body still
carry up to 160 characters the applicant chose, in the workspace's name. A hostile entry can read like an instruction. Turnstile and the F1 limit
are the controls; there is no content filter.

**F13 (info) Raw emails in the audit chain and PII in some log lines.**
`recipient_changed` events (documents and envelopes) record the old and new email; the chain is append-only, so a right-to-erasure request cannot remove
them from it. A few `console.error` lines print a database error message, which for a unique violation can contain the value (`registration-contact.ts`,
`writeback.ts`). No token, code or sensitive answer is logged anywhere (every line was read).

**F14 (info) The public verify page shows names.**
By design: title, reference, the names and times of people who signed (for a form-only document, who submitted), the fingerprint and the chain
state; nothing about sibling documents of an envelope (a count only; tested in `envelope-flow.test.ts`). Anyone holding the QR code or the document id can read
it. The id is a random UUID. The page is served with the site-wide `Cache-Control: public, s-maxage=300, stale-while-revalidate=86400`, so a cache in
front of the app could serve a completed document's page for up to a day after Doc Sign was switched off for the workspace.

**F15 (info) Unbounded growth and a fail-open limiter.**
`sign_registrations` has no clean-up job (rejected spam rows are bounded by the attempt limits, about 14,000 a day per form at the most). The shared limiter falls back
to a per-process counter when `rate_limit_hit` cannot be reached; registration needs the same database, so this is theoretical.

**F16 (info) Permissions are checked when an automation is saved, not when it runs.**
An automation with a send step is saved and kept active only by someone with `sign.send`; if that person later loses it, the automation keeps running as before.

**F17 (info) `sign_registration_forms` can be updated through the API by `sign.settings`.**
The update policy does not pin `created_by`, so a settings administrator can set it to another member (that member then owns the documents the page
makes). Template, tag and account are pinned by a trigger. Insert pins `created_by` to the caller.

**F18 (info) Address handling depends on `TRUSTED_PROXY_HOPS` and `NEXT_PUBLIC_SITE_URL`.**
The per-address limits trust the right-most `X-Forwarded-For` entry (1 hop by default). Wrong hops means every visitor looks like one address (documented in
doc-sign-setup.md section 8d) or, if the app is reachable without the proxy, an attacker picks the address. The signer-side routes build links from
`originOf(request)` and so depend on the first variable too.

### What held up (tried, did not break)

- Cross-workspace: every service read and write carries `account_id`; the public API answers 404 for another workspace's document; a template, tag or
  contact id from another workspace is refused in the registration form, the draft, and the bulk file.
- An envelope link: reaches only the person's own rows on documents of its own envelope; a row someone forged with the person's party id on another
  envelope or workspace does not appear; a token made for a non-anchor row opens nothing (`security-review.test.ts`). The code's session cookie is bound to the link's own row.
- A delegate (forwarded part): sees only its parts, no pages, no other roles' answers, no review, cannot decline, cannot pass the part on (`forward.test.ts`).
- Registration: honeypot, token forging, tampering, cross-form use, future-dated tokens, replay after two hours, one answer for a repeat and a first time,
  raw IP never stored (keyed hash only), slug has 39 bits and nothing of the workspace, Turnstile goes to one fixed address and fails closed.
- Zip names: separators, `..`, drive letters, control characters and length are removed; two hostile titles do not collide (`security-review.test.ts`).
- CSV exports: documents and bulk results go through `toCsv`, which guards `= + - @ \t \r`.
- Webhook payloads: no email, phone, token, IP, device, path or merge value for any event; none for a test document.
- Sensitive answers: ciphertext bound to document and field, no plain `value` column for a sensitive row (CHECK), every reader opens through `openRows`,
  reveal writes its event first and refuses when it cannot (`strict`).
- Bulk: rows leased with `SKIP LOCKED`, a document is recorded on its row before it is sent, a run twice at once cannot send a row twice, the monthly
  limit is applied by `sendDocument`, a CSV above the byte and row caps is refused before it is parsed.

## 3. Capability map (who can do what, as built)

| Action | Capability |
|---|---|
| See the list, open a document, download the sealed copy, a signer's uploaded file, the zip, the CSV | `menu.sign` |
| Reveal one sensitive answer | `sign.send` (rate limited, audited first) |
| Send, bulk send, test a template, replace a draft's file, change people, build an automation that sends | `sign.send` |
| Open one's own turn from Halo | `sign.sign`, and the place must be addressed to the caller's own email (F3) |
| Registration forms, option lists, add-ons, settings, certificates | `sign.settings` |
| Void | `sign.void` |
| Public API | a key with `sign:read` / `sign:write`; Doc Sign must be on for the workspace |

## 4. The database

Read in full: 162 (bulk), 164 (registration), 165 (retention), 166 (forwarding, steps), 167 (countersign notice), 168 (sensitive), 169 (form-only), 170 (tests, usage, links), 171 (envelopes).
Read for the guards and grants: 163 (option lists).

- Every new table has RLS on and a SELECT policy that follows a capability; writes by API roles exist only where intended (option lists, registration forms: `sign.settings`; nothing for submissions, batches or envelopes).
- Every new function is `REVOKE`d from PUBLIC and `anon`; those that mutate are granted to `service_role` alone. The only ones granted to `authenticated` are `account_usage` (checks `settings.workspace` or platform admin when there is a caller), `sign_verify_chain` (checks `menu.sign`) and `sign_registration_counts` (SECURITY INVOKER, so RLS decides). None takes an account or document id from the caller and trusts it.
- The retention exception (`retention_purge_active`) needs four things at once (owner role, the purge setting for this workspace, a live deletion record, `delete_workspace_data` on the stack). Setting the `vircle.purge_account` value from a session is not enough; the migration's own text states the one case it cannot stop (a database owner).
- `retention_purge_active`, `sign_forward_check`, `sign_documents_test_guard` and the retention triggers are not SECURITY DEFINER and carry no REVOKE: they are callable by anyone and return false, raise, or only run as triggers. The retention trigger functions must stay executable by the role that deletes, so a REVOKE would break deletes. Not changed.
- Envelope functions take an anchor id, are service-role only, lock in a fixed order, and are reached only through routes that look the anchor up under the envelope and the workspace first.
- The registration, bulk and option-list tables reference their parents with composite `(id, account_id)` foreign keys, so a row cannot point at another workspace's parent.
- Limits: envelope 2 to 6 documents, position 1 to 6, bulk 500 rows, `signers_other` 10, option list 5000 items and 2 MB, wording 12,000 bytes.

## 5. Not assessed

- The real network: nginx or Caddy configuration, TLS, what the proxy does with `X-Forwarded-For` and `Host`, any CDN or cache in front of the app.
- Content-Security-Policy in a browser: it ships as Report-Only (`next.config.ts`), so nothing blocks an injected script today; the Doc Sign pages have no
  `dangerouslySetInnerHTML` and escape everything they print, which is why this is not a finding.
- Supabase Realtime (the publication of `sign_envelopes`) and Storage bucket policies for the `sign` files: the policies live outside migrations 162 to 171.
- The SQL itself: nothing was run. The verify scripts for 162 to 171 and the guard catalogue passed on production (rolled back), according to the orchestrator; this review read the same SQL for logic, not for syntax.
- Email deliverability and what a mail client does with the links; Cloudflare Turnstile on the live site; the Word converter container.
- Hostile PDFs and images through the PDF engine (page and size limits exist; the engine's behaviour on a crafted file was not tested).
- Anything that needs a browser, a phone or a real signer.
