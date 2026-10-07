# Secure Sign: setup for the operator

Secure Sign is Halo's electronic signing module. It is **off for every workspace** until you
turn it on. This page is what you do on the server, and in the Platform console, to switch it
on for a workspace and keep it running. What users do is in the User Guide (**Secure Sign**).

## 1. Before anything else

- **Migrations 157, 158 and 159** are applied (`supabase/migrations/157_sign_foundation.sql`,
  `158_sign_ceremony.sql`, `159_sign_notifications.sql`). The container does not run migrations; use the Supabase CLI as in
  the README. They create the `sign_*` tables, the private storage bucket `sign-documents`,
  and the two flags below (off for every workspace, old and new).
- **`NEXT_PUBLIC_SITE_URL`** is your public https address. Signers' links are built on it.
- **Email can be sent**, one of two ways. Invitations, reminders, codes and signed copies go out by
  email, and without a sender a document can be sent but nobody is told (the document's page says so).
  Secure Sign picks the way for each workspace, in this order:
  1. **The workspace's own connected mailbox**: a Microsoft 365 mailbox (Settings > Channels > Email),
     or else a Gmail mailbox (Settings > Channels > Gmail). Mail goes out from that mailbox's address,
     under the workspace's name. Nothing to set on the server beyond what those channels already need
     (`MS365_CLIENT_ID` and `MS365_CLIENT_SECRET`, or `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`; see
     `docs/microsoft-365-email-setup.md` and `docs/gmail-setup.md`). The mailbox must be able to send
     (`Mail.Send` for Microsoft 365, `gmail.send` for Gmail): reconnect it if it was connected before
     those permissions were asked for.
  2. **`RESEND_API_KEY`** is set (the platform sender, with `RESEND_FROM_EMAIL` on a verified domain).
     Used for a workspace with no mailbox that can send.

  Either one is enough. **Settings > Secure Sign > General > Email** shows which one a workspace is using,
  with the mailbox's address, and has a **Send a test email to me** button. What to know about the
  mailbox: mail through it is marked `X-Halo-Sign: 1`, and Halo's own inbox ingestion refuses anything
  carrying that mark, so a signing link or a signed document is never read into the shared inbox
  (section 9c). Through Microsoft 365 no copy is kept in Sent Items; Gmail always keeps one in its Sent
  folder. Files go on the message only when they fit: up to 2.5 MB through Microsoft 365, 17 MB through
  Gmail, 20 MB through the platform sender; above that the message carries a link instead.
- **`ENCRYPTION_KEY`** is set (it already is for WhatsApp and Jira). Sealing certificates are
  stored encrypted with the key ring, and the **Re-encrypt now** job rewrites them after a key
  rotation (`docs/encryption-key-rotation.md`) like every other secret.
- **`AUTOMATION_CRON_SECRET`** is set (section 4).

## 2. Turn Secure Sign on for a workspace

Sign in as a platform operator and open **Platform**. Open the workspace and click **Edit**.
In the features list:

| Switch | What it does |
|---|---|
| **Secure Sign** (`sign`) | The Secure Sign menu, the pages, the routes and Settings > Secure Sign. Off removes every Secure Sign permission from every person in the workspace, so nothing is shown. Signer links stop answering (404). |
| **Secure Sign: Merchant Registration** (`sign_merchant`) | Lets the workspace install the Merchant Registration add-on from Settings > Secure Sign > Add-ons. Needs **Secure Sign** on as well. |

Also in that dialog, **Signing documents per month** is the monthly limit (empty means no
limit). The workspace's admins get a notice at 80 percent, and sending is refused at 100 percent
with a message telling them to contact support. Drafts do not count, only documents sent.
The workspace's file storage is covered by the existing storage meter.

A workspace owner or admin then finds **Secure Sign** in the sidebar and in Settings. Who may do
what inside is set in **Settings > Roles & permissions** (view, send, void, manage templates,
manage settings).

## 3. Word files: the converter

PDFs and images work with nothing extra. A Word file needs the converter, a locked-down
Gotenberg container that only the app can reach. In `.env.local` on the server:

```
COMPOSE_PROFILES=sign
SIGN_CONVERTER_URL=http://sign-converter:3000
```

Then redeploy (`docker compose --env-file .env.local up -d`). `docker compose --env-file
.env.local ps` should list `sign-converter` as `healthy`. The container needs about 1 GB of
memory while it converts and the image is large; sizes, limits and what it cannot do are in
`docs/docker.md` ("Secure Sign converter"). Without it, a Word upload says "Word conversion is
not available right now. Upload a PDF instead."

A Word file may not convert to more than 50 pages and gets 60 seconds. A PDF may have up to
200 pages. Both may be up to 25 MB.

## 4. The scheduled job

Secure Sign needs one job called every **minute**. It seals documents that everyone has signed,
expires documents past their date, sends due reminders, and sends the documents of bulk
batches (section 8c). Without it, completed documents stay in **Finishing**, no reminders or
expiries happen, and a bulk send stays on **Waiting to start**.

```cron
* * * * *   curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/sign/jobs-cron
```

It uses the same secret and header as the other jobs. It is listed in
`docs/automations-and-cron.md`, and the **Background jobs** card in the Platform console shows
**Secure Sign jobs** with the time of its last run. Late or Not running means the crontab line is
missing or wrong.

The signed copy is also attempted **right after the last signature** (the server seals in the background once the answer to the signer has gone
out, within 15 seconds and at most three documents), so it normally appears within seconds; the job is the safety net that retries what did not
finish. Both use one claim with a five-minute lease, so a document is never sealed twice. If sealing was tried and **nothing** could be sealed, the job
answers `500` with `seal_error` in its body, the Background jobs card shows it as an error, and `curl -f` exits non-zero. A document is tried up to five
times, five minutes apart, and is then marked **Could not finish** (the reason stays on it). Its sender sees the reason (people with Secure Sign settings)
and a **Try again** button on the document and on the collection; nothing the people signed is lost, and a retry is written in the document's history.

## 5. Chinese and Korean names on signed files

The fonts built into the signing engine cover English and Bahasa Melayu. A name or text in
Chinese or Korean is otherwise drawn as `?`, and the sender is warned before sending. To fix
that, put a font file with those characters on the server (for example Noto Sans CJK) and
set, in `.env.local`:

```
SIGN_CJK_FONT_PATH=/app/fonts/NotoSansCJK-Regular.ttc
```

The path is the one **inside the container**, so mount the file into it. This path has not been
proved with a real CJK font yet: try a signed test document before relying on it
(`docs/sign-dependencies.md`).

## 6. The sealing certificate

Every completed document is sealed with a digital signature. The first time a workspace
seals a document, Halo makes a **self-signed** certificate for that workspace, valid for five
years, and keeps it encrypted (table `sign_certificates`, key ring). Nothing to do for this.

What users see: PDF readers say the signer is not trusted. The seal still shows whether the
file was changed after signing, but the reader cannot check who made the certificate. The
workspace sees this under Settings > Secure Sign > Sealing certificate, with its date. A new one is made
the next time a document is sealed after it expires.

A certificate from a certificate authority (so readers show a valid signature) can be installed under
Settings > Secure Sign > Sealing certificate (`.p12` or `.pfx`, migration 165). It is checked before it is kept (expiry, key size,
key use, chain) and sealed with its full chain; a document waits in "sealing" with a readable reason while the certificate in use is
expired, and administrators are notified 30, 14 and 7 days before it ends. See `docs/doc-sign-certificate.md` for what to ask a
certificate authority for, and how to rotate. Deploy order: apply migration 165 before the new app.

## 6a. Sensitive form fields

A form field can be marked **Sensitive (encrypted and masked)** in the form builder (migration 168).
Its answer is stored only as ciphertext (`sign_answers.value_enc`, key ring; the plain `value` column is empty, a
database check refuses anything else), the sender sees it masked (`•••• 1234`) with a **Reveal** button that needs
its own capability, `sign.reveal-sensitive` (migration 176; Owner and Admin by default, grantable down to Agent in Roles & permissions; it is no longer
`sign.send`), and writes a `sensitive_viewed` event (the field and the document, never the value), and
the CSV and zip exports and the public API never carry an answer. Nothing to configure. Things to know:

- It is the encryption key that protects it: if `ENCRYPTION_KEY` (or the key a value was written with) is lost, the
  signer's page, the sender's Progress tab and the sealing job fail with `sensitive_unreadable` for that document
  until the key is back. Rotate keys the usual way (`docs/encryption-key-rotation.md`); **Re-encrypt now** covers
  this column.
- The sealed PDF prints the answer in full by default, because the signed document shows what was agreed, and the
  PDF is sent to the signers. A form can print only the last four characters or nothing (`printMasked`).
- Only answers written after a field was marked sensitive are encrypted; a document already sent keeps what it holds.
- The signer's answers are frozen in the database once they have signed (`sign_answers_guard`).
- **Who may Reveal** is only the Reveal button and its route (`POST /api/sign/documents/[id]/sensitive`). A person who held `sign.send` and relied on Reveal
  before 176 loses it until an admin grants `sign.reveal-sensitive` to their role; the button is not shown without it. Who may read sensitive answers in the sealed
  PDF, the zip and the uploaded files (owner decision F8) is a separate question and is unchanged.

## 7. Limits worth knowing

| Item | Limit |
|---|---|
| File | 25 MB; PDF up to 200 pages; Word up to 50 pages after conversion |
| People on one document | 20 |
| Roles on one document | 6 |
| Fields on one document | 300 |
| Expiry | 1 to 365 days (default 14, per workspace) |
| Reminders | up to five, each 1 to 60 days after the invitation |
| Verification code | 6 digits, 10 minutes, 5 tries, 5 codes an hour |
| Retention of signed files | 7 years by default (`sign_settings.retention_years`, 1 to 50, per workspace under Settings > Secure Sign, per category if set); a completed document cannot be deleted before its date, by anyone (`docs/doc-sign-retention.md`) |
| One bulk send | 500 people, a CSV of 1 MB, 5 fixed people; 3 batches queued or running per workspace |
| Export of the documents list | 50,000 documents, read 500 at a time and streamed |
| Zip of signed files | 50 documents and 300 MB a download, one file read at a time |

## 8. Forms

A template can carry a **form**: parts, each assigned to a role, each a list of questions. The signer opens one link, fills their parts over as many sittings as they like (their answers are saved on the server as they go), reviews the document with the answers printed on it, and signs. A part can belong to a filler role, who completes it without signing. Answers can also fill the contact when the signer submits.

Needs migration `160_sign_forms.sql` (adds `sign_template_versions.form` and `sign_documents.form_snapshot`). Apply it before a template with a form is saved; templates and documents without a form do not depend on it.

| Item | Limit or behaviour |
|---|---|
| Kinds of file a signer may upload | PDF, JPEG and PNG, decided from the file's first bytes, never its name. A field can narrow the list. |
| Size of one uploaded file | 5 MB unless the field says otherwise, at most 10 MB |
| Files in one field | 1 unless the field says otherwise, at most 10 |
| Uploads on one document | 50 MB in total, all roles together |
| Parts, questions | 20 parts, 200 questions per form |

**Where uploaded files are kept.** In the private `sign-documents` bucket, under the document's own folder: `account-<workspace id>/<document id>/upload/<file id>-<name>`. Each upload is also a row in `sign_document_files` (kind `signer_upload`) with its SHA-256, and an entry in the answer to its question. The path never reaches a browser: the signer sees their own file through their link, and staff download it from the document (the download is recorded).

**Uploads are listed in the certificate, not appended.** The certificate pages carry one line for each upload (who, the file name, the first 16 characters of its SHA-256) and one for each removal. The files themselves are not added to the signed PDF; they stay in storage with their fingerprints.

**Write-back.** A question can be tied to a contact field (name, email, company or a custom field). After the signer has signed, the answers they typed or confirmed are written to the document's contact, in the same workspace only, and only when the value differs; a question set to "only if empty" never overwrites. Every change is an audit event (`writeback`) with the old and the new value, which is personal data and is kept in the audit trail only, never on the certificate. A write-back that fails is logged (`[sign] write-back`) and never undoes the signature. Answers the signer never confirmed are not written back.

**More time.** The sender can push the expiry of a document that is still open (`POST /api/sign/documents/[id]/expiry`): later than now and later than the current expiry, at most a year ahead. It is recorded as `expiry_extended`.

## 8b. API access for the workspace's own systems

A workspace can send and follow documents from its own backend (a merchant onboarding system, for example) through the public API under `/api/v1/sign`. The reference, with request and response examples, is the **Secure Sign** part of `docs/public-api.md`. What the operator needs to know:

1. **Turn Secure Sign on for the workspace first** (section 2). The API does not look at who made the key: while the **Secure Sign** switch is off, or the workspace is suspended, every Secure Sign call answers `403 sign_disabled`.
2. **Create the key** (a workspace admin or owner): **Settings > API keys > New API key**, name it after the system that will use it, and tick only what it needs: **`sign:read`** (templates, documents, status, downloading the signed copy) and **`sign:write`** (send, remind, cancel). A reporting job needs only `sign:read`. The key is shown once; it works from its next request and is revoked from the same screen. Keys need no migration: scopes are stored as free text.
3. **No new database objects.** The caller's own `reference` is kept as the document's reference, and the existing unique (workspace, reference) rule is what makes a retry safe. A reference cannot look like `SGN-2026-000123`, which stays the system's own numbering.
4. **What shows in the history.** A document made through a key is recorded with the person who made the key as the actor, and the `created` and `downloaded` events carry `via: api_key:<key id>` so the history tells it apart from a person at the screen. The invitation emails name that person as the sender.
5. **Limits.** The same monthly **Signing documents per month** limit applies (a send over it is `429 sign_limit_reached`). Every key is also held to 120 requests a minute (and the workspace as a whole), and to 30 a minute for calls that send a message (create, send, remind).
6. **What the API never returns:** a signer's link or token, codes, IP addresses, devices, storage paths, form answers. The signed PDF is returned as bytes (never as an address) and only once the document is completed.

## 8c. Bulk send, export and zip

**Bulk send** (`/sign/bulk`, migration 162) sends one template to up to 500 people from a CSV or from contacts. The person who starts it needs `sign.send`; anyone with `menu.sign` can read a batch and its results. It needs **no new switch**: it is part of Secure Sign and follows the `sign` flag (off means no new batch, and the rows of a running batch are skipped with `sign_disabled`).

1. **The work is done by the scheduled job** (section 4), not by the browser, so closing the page loses nothing. Each minute the job claims a batch of waiting rows (taking turns across workspaces, so one big batch cannot starve the others), makes and sends one document for each through the same code as a single send, and gives back what it had no time for. Rows are leased for five minutes, so two runs never take the same row. Expect roughly 15 to 25 documents a minute: a batch of 500 takes about half an hour. A Platform console **Secure Sign jobs** result carries `bulk_claimed`, `bulk_sent` and `bulk_failed` for the last run.
2. **The monthly limit.** The batch is refused up front when it cannot fit in this month's **Signing documents per month** limit. If the limit is reached while it runs (other documents were sent meanwhile), the rows not yet sent are marked **Failed** with `sign_limit_reached`; no job fails.
3. **Never sent twice.** A row that already has a document is not made again, and a document that is already out is recorded as sent without sending it again. A row that is tried three times without finishing is marked failed (`gave_up`); its draft, if any, stays linked for the sender to open.
4. **What shows in a document's history.** The `created` event and every later event written by the batch carry `via: bulk:<batch id>`.
5. **Data.** Tables `sign_bulk_jobs` and `sign_bulk_rows` hold the list (names, emails, phones, values) so the result can be shown and downloaded. They follow the workspace export and deletion by themselves (every table with `account_id` does) and are cascade-deleted with the workspace. They are not trimmed by retention: delete the workspace or ask for them to be purged if a list must not be kept.
6. **Audit.** Each batch is one row in the audit log (entity `sign_bulk_job`: who started it, its status). The people on the list are not written to it.

**Export of the documents list** is `GET /api/sign/documents/export` (`menu.sign`, 30 a minute per person, the same limit as the contacts export) and **zip of signed files** is `POST /api/sign/documents/zip` (same capability and limit). Both are streamed: neither holds a list or the files in memory, and a zip reads one signed file at a time.

## 8d. Public registration pages

A **registration form** is a public page, `/r/<slug>`, where someone with no login enters a few details. Halo finds or creates their contact, applies a tag, and (if the form is set to) makes a document from a template and emails it to the address they typed, which is also what proves the address is theirs. It is made in **Settings > Secure Sign > Registration forms** by anyone who holds `sign.settings`. The page needs **Secure Sign** on for the workspace (section 2) and nothing else switched on: it is part of Secure Sign.

Needs migration `164_sign_registration.sql` (tables `sign_registration_forms` and `sign_registrations`; verify with `supabase/ci/verify-164-sign-registration.sql`). Apply it before the first form is made.

| Item | Behaviour |
|---|---|
| The address | `https://YOUR-APP/r/<name>-<8 random characters>`. It never contains the workspace id and cannot be found by counting. **New address** in Settings retires the old one at once. A form that is switched off, unknown, or whose workspace has Secure Sign off or is suspended answers the same plain "not available" page. |
| `ENCRYPTION_KEY` | Needed (it already is for WhatsApp and Jira). The page's signed token and the keyed hashes are derived from it. Without it the page says it is not available right now and takes nothing. No new variable is needed for this. |
| Limits | Per address: 40 posts an hour of any kind and 5 with valid details. Per form: 600 and 60 an hour, and the form's own **daily cap** (default 100 accepted a day, 1 to 5000) on top. Shared across app instances (`rate_limit_hit`). The address is only used as a keyed hash. |
| Hidden field and token | A field a person never fills (a script that fills every input is answered like a success and recorded as spam), and a signed form token: genuine, for this form, under two hours old and at least three seconds old. A token that has expired or is too fresh is sent back with a new one. |
| Same email again | One open document per email per form in 24 hours. A repeat gets the same success page and starts nothing, so the page never reveals whether an address is known. |
| Contact | Matched **by email only**. An existing contact has only its **empty** name, company and phone filled, never overwritten. A phone number that already belongs to another contact is not attached: the applicant gets a new contact without a number and the pair is shown to the agents as a possible duplicate. A new contact is a lead. |
| Tag | The form's tag is applied with the shared tag writer, so a `tag_added` automation on it runs once. If the form also sends a document, do not also send one from that automation. |
| What is stored | One row per submission with a status (accepted, spam, over the cap, failed), a short reason code, a keyed hash of the email and of the address, the browser's name cut to 120 characters, the language and the version of the agreement wording. Never the address or the email as typed. Rows are not trimmed: they are the record of what was agreed to, and go when the workspace is deleted. |

**Environment variables.** None are required. Optional, to switch on the Cloudflare **Turnstile** bot check (both must be set, in `.env.local` on the server, then restart: they are read when a page is drawn, so no rebuild is needed):

```
NEXT_PUBLIC_TURNSTILE_SITE_KEY=0x4AAAAAAA...
TURNSTILE_SECRET_KEY=0x4AAAAAAA...
```

Make a Turnstile widget in the Cloudflare dashboard (type **Managed**, add your domain) and copy its **site key** and **secret key**. With both set, the page shows the widget, the button waits for it, and the server asks Cloudflare (`challenges.cloudflare.com`, through the app's guarded fetch) to confirm the token; a check that cannot be made refuses the submission. With either missing nothing changes: limits, the hidden field and the token still apply. **Settings > Registration forms** says whether the check is on.

**Content Security Policy.** The app's policy is `Content-Security-Policy-Report-Only` (`next.config.ts`). For `/r/:slug*` only, that policy also allows `https://challenges.cloudflare.com` for scripts, frames and connections, so the widget works if the policy is ever enforced. The same route is sent `Cache-Control: private, no-store`, because every visit carries its own signed token. No other route changes.

**Behind a proxy.** The per-address limits use the address `TRUSTED_PROXY_HOPS` points at (default 1; see `src/lib/net/client-ip.ts`). If it is lower than the number of proxies in front of the app (Cloudflare in front of Caddy is 2), every visitor looks like the same address and five registrations an hour then block everyone. With `0` the per-address limits are skipped (every visitor would be one bucket) and only the per-form limits and the daily cap apply.

**The consent wording** a page shows is `DEFAULT_REGISTRATION_CONSENT` in `src/lib/sign/registration/consent.ts` (four languages) unless the form sets its own. It is a starting point and has **not** had a legal read for the PDPA 2010: have it reviewed before real applicants use the page. The signing consent on the signing page is a separate agreement made later by the person who signs.

## 8e. Countersigning inside Halo, "Awaiting my signature" and "Needs attention"

A role of a document can be a **Halo user** (`sign_signers.internal_user_id`; the send step takes it as `internalUserId` and, from migration 167, refuses an id that is not a member of the workspace). That person signs on the same page as everyone else, through the same endpoints and with the same consent and sealing. The difference is how they are recognised: Halo already knows who they are, so the verification code is skipped.

Needs migration `167_sign_countersign.sql` (verify with `supabase/ci/verify-167-sign-countersign.sql`). It adds the notification type `sign_your_turn` and a trigger on `sign_signers` that tells the Halo user, inside Halo, the moment their step is invited (at the send for an unordered document, when the step before finishes for an ordered one). Nothing else in the database changes.

| Item | Behaviour |
|---|---|
| **Awaiting my signature** | `GET /api/sign/awaiting-me` (`sign.sign`): the documents sent or in progress where the signed-in person's own place is invited and not finished (with signing order, their step has begun). A count badge on **Sign** in the sidebar and a shortcut at the top of the documents list use it; they refresh every minute, on focus, and when the tab is shown again. Only people with `sign.sign` (Admin and Owner by default; a custom role can be given it) see it. |
| **Sign now** | `POST /api/sign/documents/[id]/countersign` (`sign.sign`, 20 a minute per person). The caller must be the Halo-user signer on that document in their own workspace (found by their user id, never by an id from the browser), else 403 `not_a_signer` (the same answer when the document does not exist). 409 `not_your_turn`, `document_not_open`, `already_signed` or `signer_not_open` otherwise. It rotates that one signer's link exactly as a reminder does (the link in their earlier email stops; nobody else's link changes; no message is sent), sets the signed signer session cookie (`sgs-<signer id>`, HttpOnly, 12 hours) so the code is not asked, and answers `{ url: "/s/<link>" }` for the browser to open in the same tab. |
| **Audit trail** | Two events: `halo_link` (a signing link was made when the person opened the document inside Halo; kept off the certificate) and `code_verified` with `detail.method = "halo_login"`, with the person's user id, address and browser. The certificate says "was identified by their Halo sign-in (verification method: Halo login)" in all four languages instead of "entered the verification code". |
| **Needs attention** | `GET /api/sign/attention` (`menu.sign`): documents declined or expired in the last 30 days, any that failed to seal, and open documents where a message to someone did not arrive and nothing has put it right since (a reminder, a new link or a changed recipient that then went through clears it). Only failures the app saw are known: a bounce reported later by the mail provider is not recorded anywhere, so it cannot appear. |

If a Halo user also has the emailed invitation open in another tab, **Sign now** replaces that link (the old tab keeps its page but its next save fails with "link not valid"); they continue in the tab Halo opened.

## 8f. Option lists

A data field of a form can name a shared **option list** instead of carrying its own options: Settings > Secure Sign > Lists (capability `sign.settings` to change, `menu.sign` to read; help article `content/help/doc-sign/option-lists.md`). Needs migration `163_sign_option_lists.sql`. The form builder and the signing page that come with it use the lists; an older deploy simply never sees `optionList`.

**What ships.** Seven system lists are copied into a workspace the first time Secure Sign opens (`sign_ensure_defaults` calls `sign_seed_option_lists`), and by the migration into every workspace that already has Secure Sign data: `states_my` (13 states and 3 federal territories), `countries` (ISO 3166-1, 249 entries), `banks_my`, `company_id_types`, `einvoice_phases`, `tax_types` and `msic`. The content is in `src/lib/sign/lists/system-lists.ts`, which generates the function `sign_option_list_defaults()` in the migration (a test fails if the two drift apart; after changing a list run `UPDATE_LISTS_MIGRATION=1 npx vitest run src/lib/sign/lists/migration`, then add a migration that replaces the function with a higher `version` for the change to reach the database). A workspace keeps its own copy: relabel, add, reorder and archive items; the values of a system list can never be deleted (the database refuses). "Reset to default" puts the shipped wording back and keeps what the workspace added.

**The MSIC list.** It is the full MSIC 2008 as published by the Department of Statistics Malaysia, retrieved on 2026-10-07 from its open data catalogue (`https://open.dosm.gov.my/data-catalogue/msic`, licence CC BY 4.0): 21 sections, 88 divisions and 1,174 five-digit classes, each in English and Bahasa Melayu, exactly as published apart from the footnote markers the source glues to the Malay text. The source, the checks that were made and what was not checked are in the header of `src/lib/sign/lists/msic.ts`. LHDN's e-invoice MSIC list is the same classification. The signer's picker shows the code with the description; an admin can edit any wording, or import a CSV (code, English description, Malay description) to change many at once.

**A form is frozen with the lists it names.** The builder posts only the list's key; the server copies the list's items into the field's `options` when a template version is saved, when a draft is made from a template and when a document is sent (`resolveFormLists`, `src/lib/sign/forms/lists.ts`). The signing page, the answer checks and the printing read only those copied options, so a later edit of a list never reaches a document that was sent. A list that has gone cannot stop a document that was prepared with it.

**Size.** A form that names MSIC carries about 200 KB of options. The limit on `sign_template_versions.form` and `sign_documents.form_snapshot` is raised from 400 KB to 2 MB by the migration, and the server refuses a form over 1.5 MB (`form_too_large`). Two forms using the full MSIC list twice are still well inside it.

## 8g. Steps that sign together, and forwarding

Needs migration `166_sign_forward_parallel.sql` (verify with `supabase/ci/verify-166-sign-forward-parallel.sql`). Help article: `content/help/doc-sign/forwarding-and-parallel-signing.md`. No new switch or capability: it is part of Secure Sign and follows the `sign` flag; the signer's routes answer 404 for a workspace with Secure Sign off like every other.

**Steps.** With signing order on, people who share an order number form one step: all of them are invited when the step begins, and the next step begins when every one of them has finished (the ceremony functions of 158 already worked this way; phase 1 only stopped the sender giving two people one number). The sender's people list shows `Step 1 (2 people)`, and the public API accepts a shared `order_no`. A decline by anyone stops the document; reminders and expiry are unchanged (a person of a later step has no link yet and is not reminded). The audit trail records each invitation with its cause (`because: signer_finished` with the name, or `step_finished`), and the sealed certificate lists the signers in step order. A person whose step has not begun can be re-addressed (`Change recipient`, nothing is sent) or moved to a later step (`Move to`, `sign_move_signer`).

**Forwarding.** Off unless the sender switches it on: for a template (its options, stored in the version's `defaults.allow_forwarding`) or for one document (`sign_documents.allow_forwarding`, changeable by `sign.send` while the document is open, an audit event after sending). A signer then hands their whole turn (the same `sign_signers` row gets a new person and a new link, the old link dies at once, nothing they agreed to or signed carries over, `forward_history` keeps the name) or one part of a form (a delegate: a filler row of the same role with `part_keys` and `delegated_by`, in the signer's step, who sees only that part and never signs). At most two forwards per position (`MAX_FORWARDS` in `src/lib/sign/forward.ts`, turns and parts together), six an hour per position, never to the forwarder's own address or to someone already on the document for the role (anyone, when the document needs order). The sender gets a notification (`sign_forwarded`) and an email for a turn; every forward and take-back is an audit event with names and a masked address, never a link. A forward is not a new document for the monthly limit. A delegate is not sent the signed copy of the whole document by email.

| Setting | Where |
|---|---|
| Forwarding for a template | Template editor, options: **Allow forwarding** |
| Forwarding for one document | The options step of a draft, or the checkbox on the document's page while it is open |
| The limit of two | `MAX_FORWARDS` (code), also the `p_max` the server passes to `sign_forward_turn` and `sign_forward_part` |

## 8h. Forms without a signature

Needs migration `169_sign_form_only.sql` (verify with `supabase/ci/verify-169-sign-form-only.sql`). Help article: `content/help/doc-sign/forms-without-signature.md`. No new switch or capability: it follows the `sign` flag and `sign.templates` / `sign.send`. Apply 169 before deploying the app of this version: the documents list, the template library and the public API read the new `mode` column.

**What it is.** A template, each of its versions and each document has a `mode`: `sign` (an agreement, everything before this section) or `form` (a form in parts that people fill in and submit; nothing is signed). The mode is chosen when a template is made (**Templates > New template > Form without a signature**, `POST /api/sign/templates` with `{ "mode": "form", "name" }`) and never changes: a database trigger refuses it, a version must carry its template's mode, and a document copies its version's mode when it is made. An agreement writes no `mode` at all, so nothing about it depends on the column.

**Rules, held in the app (with words) and again in the database when the document is sent** (`sign_send_document`): every person is a filler (a role that signs is refused: `form_mode_signer_role`, `form_mode_has_signer`); no signature, initials or signing-date place and nothing else placed on a page (`form_mode_signature`, `form_mode_placement`; the form is the only thing asked); the form has at least one part (`form_mode_needs_a_form`, also when a template is made active). There is no document to read, so the base file is a one-page stand-in (`blankFormPage`, the same bytes every time) kept only because every sent document has a fingerprinted base file; the signer's page never shows it and the sender's page never offers it.

**The ceremony** is the existing one (migrations 158 and 166, recreated in 169 only where the words differ): consent (its own default wording, `default-form-v1-<lang>`, in four languages; a workspace's own wording applies to both kinds), the code, the parts with autosave, uploads, a review step ("Review and submit"), then Submit. The event is `submitted` for everyone, and when the last has submitted the document goes to `sealing` with the event `all_submitted`. Write-back to the contact, reminders, forwarding of a part, the progress view, the expiry and the void are unchanged.

**The record.** The sealing job (`seal.ts`) builds a PDF from the stored answers instead of stamping a document: `src/lib/sign/pdf/record.ts` draws the answer pages (title, who and when, each part's answers in the document's language, the files with their SHA-256, the audit trail's fingerprint), then `appendCertificate` adds the certificate pages with the words of a submission (`certificate-words.ts`), `sealPdf` seals it, and `sign_finish_sealing` makes it the document's final file. So the rule that a completed document has a sealed final file (`sign_documents_guard`) is the same, the public verify page and the download work unchanged, and retention applies as for any signed document. The file is named `<reference>-record.pdf`. A **sensitive** answer is printed only as its mask (`**** 4567`, `maskText` in `forms/sensitive.ts`), whatever `printMasked` says; the full value never leaves its encrypted column. Pictures people drew or uploaded are not printed (the record says one was attached); uploaded files are listed with their fingerprints and are not appended. The record uses the same fonts as the certificate pages: answers in Chinese or Korean need `SIGN_CJK_FONT_PATH` (section 5), otherwise those characters print as `?`.

**Messages** (`src/lib/sign/messages.ts`, four languages): the invitation says "Please complete your details", the reminder names the parts left, the completion mail to the submitter and the sender says "Received" with the record attached, and a refusal, an expiry and a forwarded turn are worded as a form. The in-Halo notification to the sender says "Submitted: <reference>".

**Everything that lists documents or templates** shows the mode: the documents list and the detail screen (a "Form" label, "x of y submitted", no signature counts, a **Record** tab), the send wizard (the first step is the form, the people step says who fills it in), the template library (a "Form" badge; it opens the form builder, never the page editor), the form builder (a **People who fill this in** panel to name the roles), the registration forms (see below), the CSV export (a last column, `mode`: `sign` or `form`), the public API (`mode` on documents and templates), the webhook payload (`data.mode`) and the automation step, bulk send and registration pages, which start a document from a template and so get its mode with no change of their own.

**Registration pages.** `sign_registration_forms.mode` takes `sign` or `form` (it only ever held `sign` before). The mode must be the mode of the form's template while the form sends a document: choosing another template changes the form's mode with it, and an explicit mismatch is refused (`template_mode_mismatch`, in the database and in the readiness check). The public page says "We will email you a link to complete the rest" for a form.

**Limits.** A form without a signature is a document sent like any other: it goes through `sendDocument`, so it counts toward `sign_documents_per_month` once, when it is sent (`account_usage().sign_documents_month` counts every sent document, whatever its mode). The people, expiry, reminder and retention limits are the same.

**Not changed, on purpose.** Migrations 169 recreates `sign_documents_guard` (160), `sign_send_document` (158), `sign_record_consent` (158), `sign_complete_signer` (166), `notify_sign_document_finished` (159) and `sign_registration_forms_guard` (164). A later migration that recreates one of these must start from 169's text, or form documents lose their rules.

## 8i. Test documents, tickets and deals, replacing a draft's file, add-on updates

Needs migration `170_sign_misc_p2.sql` (verify with `supabase/ci/verify-170-sign-misc-p2.sql`). Help articles: `content/help/doc-sign/test-mode.md`, and the changes to `templates.md`, `prepare-fields.md`, `send-a-document.md` and `categories-and-add-ons.md`. No new switch or capability: it follows the `sign` flag and `sign.send` / `sign.settings`. Apply 170 before deploying the app of this version: the list, the detail screen and the signing page read the new `sign_documents.test` column.

**Test documents (F-10).** The template page's **Send a test** (`POST /api/sign/templates/[id]/test`, `sign.send`, 10 a minute) makes a draft from the template with `test = true` (a template that is still a draft may be tested, an archived one may not), names the signed-in person on every role that has fields or a part of the form (with their own Halo user id, so it shows under "Awaiting my signature"), and sends it through `sendDocument`. What the flag changes, each in the one place that owns the rule:

| Rule | Where |
|---|---|
| Not counted toward `sign_documents_per_month` | `sendDocument` skips `assertCanSendDocument` for a test; migration 170 recreates `account_usage()` (from 157's text) with `AND NOT s.test`, so the Platform usage meters and the limit check agree |
| No webhook, no automation | `emit()` in `service/outbound.ts` returns for a test document (every hook point goes through it) |
| TEST on every page | `pdf/testmark.ts`: a faint diagonal TEST and a line along the top, drawn on the file as it is **sent** (so signers see it and the sealed copy inherits it), and on the certificate pages at **sealing** (`seal.ts` marks the pages after the document's own). Built-in Helvetica Bold, no font file; page rotation and crop boxes are handled |
| TEST in messages | `docFacts()` puts `[TEST]` in front of the title, which every invitation, reminder, code and outcome message uses |
| TEST on the signing page | a red band under the header (`SigningView.document.test`) |
| Kept 30 days | trigger `sign_documents_test_retention` caps `retain_until` at completion + 30 days (the retention lock of 165 only refuses to shorten an existing date; at completion there is none yet). Test documents that never complete (declined, expired, voided) are not deletable, like any such document |
| Fixed once sent | trigger `sign_documents_test_guard`: a draft may become a test or stop being one; after sending the flag cannot change either way |
| Not in lists that are about real work | the public API's document list, the CSV export (unless the **Test** group is the one exported) and "Needs attention" leave tests out; the documents list shows them with a **Test** label and a **Test** group chip (only offered while there are tests); the zip of signed files takes any ticked document |
| Not reachable from bulk or the API | those never pass `test`; `createDraftFromTemplate` writes the column only for a test |

It goes only to the person: each address must be one they have (their sign-in or profile address) or the same mailbox with a `+tag`; the server checks this, not the browser. If the template signs in order and one address holds several places, the test document does not sign in order (and says so). No reminders are sent for a test (`reminder_days = []`).

**Attach to a ticket or a deal (F-51).** `sign_documents.ticket_id` and `deal_id` already existed (157) with a foreign key on the id alone, which crosses workspaces. Now `service/links.ts` decides every pair of ids for every way a document is made or changed (new document, template picker, the draft's PATCH, API, bulk): the ticket and the deal must be in the workspace, must belong to the document's contact when it has one, and give the document their contact when it has none. Migration 170 adds `sign_documents_links_guard`, the workspace line in the database for anything that forgets. The send wizard has a **Ticket** and a **Deal** picker beside the contact; the ticket page and the deal sheet have a **Documents** panel (the same component as the contact's tab, `components/sign/detail/contact-documents.tsx`). There is no ticket activity feed for other objects, so nothing is written to the ticket's activity.

**Replace the file of a draft (F-77).** `POST /api/sign/documents/[id]/replace-file` (`sign.send`, 20 a minute; multipart `file`, `dryRun=1` to only find out): a draft only (a sent document's file is fingerprinted and the database refuses to change it). The pure decision is `src/lib/sign/replace-file.ts`: a field keeps its place when its page exists and is the same size (2 pt tolerance); a field whose page is gone is moved to the last page and flagged `page_missing`; a field on a page of another size or shape is flagged `size_changed` and left; one that was not inside its page is flagged `outside_page`. Nothing else of the draft changes. The old files are removed only from the document's own folder, after the row was updated (the update is conditional on the draft status, so a send that got in first wins and the new file is removed). The event `file_replaced` is in the history and left off the certificate.

**Add-on updates (F-81).** A manifest has a `version` ("major.minor", compared as numbers), `changes` (what each version changed, per language) and `history` (the templates of the versions it replaced). Settings > Secure Sign > Add-ons shows **Update available** with the changes, and **Update** (`POST /api/sign/addons` with `{ "key", "action": "update" }`, `sign.settings`). Per template of the add-on: a template whose content (fields, roles, form without the options a list copied in, defaults) still equals a shipped version, and whose file is the shipped file, gets a **new version**; any other template is left exactly as it is and an **"<name> (updated)"** copy is made beside it; a deleted template is not brought back; one already at the new version is skipped, which makes a second press harmless. Documents and drafts are never touched. `sign_addons.installed_version` is changed last, so a failure is repeated by pressing Update again; the database logs the change (migration 157's trigger: who, which version). To ship a new add-on version: raise `version`, add its `changes`, and move the version it replaces into `history`.

**Merchant Registration 2.0.** The choices (state, country, bank, company ID type, e-invoice phase, tax type) name the shared lists and the MSIC codes are picked from the MSIC list (`optionList`); the bank account and the business registration number are sensitive (`sensitive`), the account printed on the sealed copy as its last four digits. The PDF and layout did not change (the file is drawn from the version-1.1 form, `MERCHANT_FORM_V1`). The tax identification number is not marked sensitive: it is on every e-invoice and staff need it in full. These are decisions to confirm with the owner.

## 8j. Document collections: several documents signed in one sitting (F-18, migration 171)

The product word is **document collection** (people never see the word "envelope"); the code, the routes and the database keep the name envelope. The model and the reasons are in `docs/sign-envelopes-design.md`; this is what to know to run it.

- **What it is.** `sign_envelopes` holds the shared things (title, reference `COL-YYYY-nnnnnn` (`ENV-` before migration 176; a stored reference is never rewritten and both are valid everywhere), contact, message, expiry, signing order, code); each document stays a normal `sign_documents` row with `envelope_id` and `envelope_position` (1 to 6, fixed once set, set only on a draft). A person who is on several documents has one `sign_signers` row per document, tied by `party_id`; the row on their first document is the **anchor** (`party_id = id`) and the only one with a link token. The collection's status is derived by the database from its documents (`sign_envelope_derive`, mirrored in `envelopes/status.ts`).
- **Limits.** 2 to 6 documents, 300 pages and 50 MB in all (`envelopes/status.ts`). Every document counts toward `sign_documents_per_month`: the send checks the whole collection against the headroom first (`signSendHeadroom`) and sends nothing when it does not fit.
- **Where it lives.** Sender side: `/api/sign/envelopes` and `.../[id]` (`sign.send`, `sign.void` for cancel), pages `/sign/new/envelope` and `/sign/envelopes/[id]`, services `service/envelopes.ts`, `envelope-data.ts`, `envelope-delivery.ts`. Signer side: the same `/s/<token>` link; `lookupByToken` returns a `party` (the collection and **only that person's** rows and documents), `?doc=<id>` picks a document, and `POST /api/sign/public/[token]/envelope/finish` completes the person's documents in order (`envelope-signing.ts`). The signing page is the same screens per document (`signer/envelope-bar.tsx` adds the list); nothing is forked.
- **Sending.** `sign_send_envelope` sends every document in one transaction, then invites the first step with ONE invitation per person (`sign_envelope_invite_step`). With signing order, the next step is invited when it is finished on every document, once.
- **Sealing and the end.** Each document is sealed on its own (its own certificate, with an optional collection block: reference and count). `sign_envelope_settle` claims completion once; the combined email (all signed PDFs, attached up to 20 MB, the rest by the person's own link) goes out once per person and once to the sender. A document collection that ends without completing (declined, expired, cancelled) tells its people once (`sign_envelope_claim_end`).
- **Rules held in the database.** A document of a document collection cannot allow forwarding and cannot be a test (trigger); `sign_send_document`, `sign_void_document` and `sign_decline_signer` refuse a document of a document collection (`document_in_envelope`); cancelling is refused once any document is sealing, completed or failed (`envelope_partly_completed`); change recipient is refused once the person signed anything (`envelope_person_has_signed`).
- **Events.** `envelope_sent`, `envelope_completed`, `envelope_declined` on each document's chain, with words on the detail page and the certificate.
- **Public verify page.** Shows one line when the document was signed in a document collection (the count only; no names or titles of the others).
- **Checking the SQL.** `supabase/ci/verify-171-sign-envelopes.sql` (RLS, grants, send refusals, one invitation and one token per person, ordered steps, per-document sealing and derived status, settle once, void and decline rules, change recipient, expiry notice once, a plain document unchanged). It was run in a PGlite stand-in, not on a real Postgres.
- **Not done yet.** Creating a document collection from an automation or the public API (the API shows `envelope_id` read only); a bulk send of document collections; removing or adding a document to a document collection after it was created (a draft collection is deleted and made again).

## 8k. People who receive a copy, and the collection people model (migration 175)

Two changes that go together. The owner's words for the collection screen: add each person once with a name and an email, choose **Signature required** or **Receives a copy**, and give the roles on each document when a signature block is placed, not in a table of roles per document.

- **The collection's people.** In **People** a person has a name, an email and a type (**Signature required** or **Receives a copy**). A document of a collection with no roles of its own (an uploaded file) takes one role per person who must sign: role key = the person's own key (`pp_xxxxxxxx`), label = their name, `SignRole.source = "people"`, colour = their place 0 to 5. They are kept in step server-side while the collection is a draft (added, renamed, removed; removing a person takes the fields assigned to them off the uploaded documents), and the editor shows them locked as "from the collection's people". Max 6 people who must sign when the collection has an uploaded file (`MAX_ROLES`), 20 otherwise. A document from a template keeps the template's roles; **Match the template's roles** says which person has each (`autoMatchTemplateRoles` fills it when a role label equals a person's name, or when there is one person and one role). Code: `src/lib/sign/envelopes/roles.ts`, `src/lib/sign/client/envelope-form.ts`.
- **Send.** A person who must sign signs only the documents with at least one field assigned to them; their row on the others is left off and the link is re-anchored on the first document they do sign. The problems are listed per document: `document_nobody` (nobody has anything to do on it), `person_without_work` (nothing assigned to that person anywhere), `too_many_roles` (6), `too_many_copies` (10), next to the existing `signer_name`, `signer_email`, `duplicate_person`.
- **The table.** `sign_copy_recipients` (migration 175): one row per person per target, the target being a document on its own (`document_id`) or a document collection (`envelope_id`), exactly one of the two. `full_name`, `email` (same check as a signer), `created_by`, `notified_at`. One row per target and address, case ignored. A trigger (`sign_copy_recipients_guard`) allows a new row only while the target is a draft, sent or in progress, refuses a document of a collection (the people belong to the collection), allows at most 10 per target (counted under an advisory lock) and lets only `notified_at` change afterwards. They are not signers: no row in `sign_signers`, so progress, reminders, webhooks, the API's `signers`, the exports and "x of y signed" never see them.
- **Access.** RLS: members with `menu.sign` read; every write is the server's (service role), and the routes check `sign.send`. Routes: `POST|PUT|GET /api/sign/documents/[id]/copies`, the same under `/api/sign/envelopes/[id]/copies`, `DELETE .../copies/[copyId]`, and the collection's `PUT .../signers` saves both lists in one call. Service: `service/copy-recipients.ts`.
- **Audit and history.** The audit entity is `sign_copy_recipient`, recorded by **name only** (the address is never written to the audit log). The document's history gets `copy_recipient_added` and `copy_recipient_removed` with the name and the masked address; they are left off the certificate. A collection writes them on each of its documents.
- **Export and deletion.** Workspace export and deletion (migration 153) find the table by itself: it has `account_id` with a cascade.
- **The mail.** `service/copy-delivery.ts`, called from the same two places that mail the signers when a document is completed (`outcome.ts` for a document on its own, `envelope-delivery.ts` for a collection), in the same step. Each person is claimed first with one `UPDATE ... SET notified_at WHERE notified_at IS NULL` that returns only the rows it changed, so a repeat or a concurrent run of the completion step cannot send twice. A message that could not be delivered gives the claim back and writes `delivery_failed` (kind `copy`), so the screens keep saying "Not sent yet" for that person; nothing retries it by itself (the same as the signers' completion mail), and a crash between the claim and the send also leaves the person unsent, never double-sent. A person who was just mailed as a signer or as the sender is not mailed twice. The words are in `src/lib/sign/copy-messages.ts` (en, ms, zh, ko; the document's language).
- **Attachments.** The sealed PDF already holds the certificate pages. One document: attached up to 20 MB. A collection: ONE message with every signed file, attached in order while they fit in 20 MB in all (`ENVELOPE_ATTACH_BYTES`). A file that does not fit is **never** sent as a download link (a link would open the file to whoever holds it): the message says to ask the sender and gives the public check page, which shows no document. A form without a signature sends the sealed submission record (sensitive answers masked, as in the record).
- **API and automations.** `POST /api/v1/sign/documents` takes `copy_to` (see `docs/public-api.md`), saved inside the same all-or-nothing create. The automation step `send_sign_document` takes recipients with `kind: "copy"` (a recipient without a `kind` signs, as every saved configuration did before). The API gives their names back, never their addresses.
- **Checking the SQL.** `supabase/ci/verify-175-sign-copy-recipients.sql`.
- **Bulk send and registration forms.** Done in migration 176, see 8l.

## 8l. Private documents, copy recipients for bulk and registration, the COL- prefix, the Reveal permission (migration 176)

- **Private documents.** `sign_documents.is_private` and `sign_envelopes.is_private` (default false). A private document or collection is seen, with everything about its progress, only by its uploader, the workspace's admins and owners, and the Halo users named as signers on it (`sign_signers.internal_user_id`; a collection is one thing, so a Halo user named on any of its documents sees the collection and every document of it). Everyone else with `menu.sign` gets "not found" in lists, by id, in counts, exports, the zip and the API. The uploader chooses on step 1 of the sending process (**Private document**), the choice is fixed once sent, only the uploader or an admin may change it on a draft, and a private draft is edited, sent or deleted only by them (a named signer reads it). Documents made by automations, bulk send and registration forms are never private. Details and the reasons are in the header of the migration.
  - **Database.** Row level security on `sign_documents`, `sign_envelopes`, `sign_document_files`, `sign_signers`, `sign_step_invites`, `sign_answers`, `sign_events`, `sign_copy_recipients`, `sign_bulk_rows` and `sign_registrations`, through four SECURITY DEFINER helpers (`sign_document_visible`, `sign_envelope_visible`, `sign_is_named_signer`, `sign_is_named_on_envelope`; executable by signed-in and signed-out roles because a policy is evaluated for both, and they say no to a caller with no session). `sign_verify_chain` answers "not found" to a signed-in person who cannot see the document. Triggers: a document of a collection takes its collection's flag; the flag of a collection moves onto its documents; a private document does not join a public collection; the flag is fixed once sent; a signed-in person who is neither the uploader nor an admin cannot change it.
  - **Server.** The services read with the service role, so each read asks the same question: `src/lib/sign/service/privacy.ts`. `loadDocument` and `loadEnvelope` refuse a private row the caller may not see (every service starts there); the lists the server builds (Needs attention, the CSV, the zip, the API list) are narrowed with `documentListScope` / `visibleDocuments`. A **public API key sees no private document at all** (a key is an integration, not a person). The system (jobs that seal, expire and remind, a signer's own link) is not restricted.
  - **Left as they are, on purpose.** The public verify page (anyone holding a signed file can check it; it shows the title, reference and who signed, never the answers); workspace webhooks and automations that fire on a document's events (an admin configured them, like an admin reading the document); the monthly usage count (`account_usage`, a number); a template's "in use" warning counts only documents the editor can see.
  - **Checking the SQL.** `supabase/ci/verify-176-sign-private-reveal-copy-prefix.sql`.
- **Copy recipients for bulk send and registration forms.** A bulk batch keeps a list of people who receive the signed copy in its options (`options.copyTo`, which a batch never changes after it is made); a registration form keeps it in `sign_registration_forms.copy_recipients`. Both are a JSON list of `{ fullName, email }` checked by `sign_copy_list_valid` (at most 10, a name and an address like a signer's, each address once). The runner (`runBulk`) and the registration submit put the list on every document they make through `applyCopyList` (`service/copy-recipients.ts`), the same rows and the same delivery as people added by hand; a person who signs that document is left out of its list. The list is never on the public registration page and is recorded in the audit log by name only.
- **Reference prefix.** A new collection's reference is `COL-YYYY-nnnnnn`. Collections made before 176 keep `ENV-`; nothing parses the prefix.
- **Permission.** `sign.reveal-sensitive` (see 6a).

## 9. Troubleshooting

| What you see | Likely cause and fix |
|---|---|
| No **Secure Sign** in the sidebar or Settings | The **Secure Sign** switch is off for the workspace, or the person's role lacks the permission. Check Platform first. |
| Signer link says "This link is not valid" | The link was cut off, was replaced by a newer one (a reminder, resend or change of recipient replaces it), or Secure Sign is off or the workspace is suspended. |
| Documents stay in **Finishing** | The scheduled job is not running (check the **Background jobs** card and the crontab), or sealing is failing: the document's page says "The last try at the signed copy did not work" with the reason, and section 9a shows how to read it. |
| Document shows "Could not finish" | Sealing failed five times. Put the cause right (certificate, `ENCRYPTION_KEY`, a missing file) and press **Try again** on the document or the collection. The reason is on the page and in the server log (`[sign] sealing failed for ...`); section 9a. |
| "Word conversion is not available right now" | `SIGN_CONVERTER_URL` is empty, or the container is not running or not healthy (section 3). |
| A Word file "took too long" or "could not be converted" | Ask for a PDF. Large or unusual files can fail; the converter keeps no state. |
| A signer cannot upload a file | It is not a PDF, JPEG or PNG, or it is over the field's limit (section 8), or the document has reached 50 MB of uploads. |
| Nobody receives invitations | The workspace has no connected mailbox that can send and `RESEND_API_KEY` is not set (section 1), or the mail is in spam. The document's page says when a message could not be delivered, and why. **Settings > Secure Sign > General > Email** shows which way email goes and can send a test (section 9b). |
| Invitations say "Reason: the connected mailbox needs to be reconnected" | The mailbox's access was revoked or has expired (a password change, an administrator removing the app's consent, a Microsoft refresh token not used for 90 days). Reconnect it in Settings > Channels. Until then the platform sender is used when `RESEND_API_KEY` is set, otherwise nothing is sent. |
| Invitations say "Reason: the mailbox has reached its limit on messages sent in one day" | Gmail allows about 500 a day for a consumer account and 2,000 for Google Workspace; Exchange Online about 10,000 recipients a day. Secure Sign stops asking for ten minutes and reports the same reason for every message in that time. The limit resets within 24 hours; use **Resend** on the people who were missed (a bulk send settles as sent with these people marked "did not arrive"). |
| Invitations say "Reason: ... asked us to slow down" | The mailbox sent too fast (Gmail: a few a second; Exchange Online: about 30 messages a minute). Secure Sign spaces its sends out and waits once for the time Microsoft names; a long bulk send can still hit it. Use **Resend** a minute later. |
| A signed copy arrives without its file and with a link | The file is over what the way email goes can carry (2.5 MB through Microsoft 365, 17 MB through Gmail, 20 MB through the platform sender). The signer's message links to their copy; people who only receive a copy are given the public check page and told to ask the sender. |
| WhatsApp invitation not delivered | The workspace has no approved message template set in Settings > Secure Sign > General, or its WhatsApp channel is off. |
| Chinese or Korean text appears as `?` | No CJK font (section 5). |
| A template cannot be saved: "the list ... does not exist" | A field names an option list the workspace does not have (it was typed in by hand or the lists were never seeded). Open Settings > Secure Sign > Lists, which seeds the system lists, and choose an existing list. |
| A signer cannot find a code in the MSIC picker | The code is not in the list (MSIC 2008 has 1,174 classes), or the form was sent before the code was added: a document keeps the list it was sent with. An admin can add the code to the list; a new document picks it up. |
| "Monthly limit reached" when sending | The workspace is at its **Signing documents per month** limit. Raise or clear it in Platform. |
| A bulk send stays on **Waiting to start** | The scheduled job is not running (section 4), or the workspace is suspended. |
| A bulk send says "Three bulk sends are already running" | The workspace has three batches queued or running. Wait for one to finish or cancel one. |
| Rows of a bulk send are **Failed** with "monthly limit" | The workspace reached **Signing documents per month** part way. Raise it in Platform, then send those people again in a new batch. |
| A registration page says "not available" | The form is switched off or its address was replaced (**New address**), Secure Sign is off for the workspace or it is suspended, or the link was typed wrong. All look the same on purpose. |
| A registration page says "not available right now" | The server has no `ENCRYPTION_KEY` (section 1): it cannot sign the page's token. |
| An applicant says no email came | Open **Settings > Secure Sign > Registration forms > Recent activity**. "The document was made but the email could not be delivered" means email is not set up or could not be sent (section 1: a connected mailbox, or `RESEND_API_KEY` and its sender domain) (the document is open; resend it from its page, the reason is on it). "The monthly limit of documents is reached" means the Platform limit (section 2). A repeat within a day is not sent again. |
| Every visitor to a registration page is told "too many tries" | The proxy count is wrong (`TRUSTED_PROXY_HOPS`, section 8d): all visitors look like one address. |
| The Turnstile box never appears | One of the two keys is missing (the page then has no check at all), or the browser blocks `challenges.cloudflare.com`. The page says the check could not load and the button stays off until it does. |
| A signer sees no "Forward" link | Forwarding is off for the document (section 8g), the position already forwarded twice, or the person was handed one part (a delegate cannot pass it on). |
| A forward fails with "That person is already on this document" | The address belongs to someone on the document for the same role (or to anyone on it, when the document needs signing order). |
| A person handed a part says they cannot see the document | By design: they see only that part, not the pages, and are not sent the signed copy. |
| Add-on card says "Not available" | **Secure Sign: Merchant Registration** is off for the workspace (section 2). |
| PDF reader says the signature is not trusted | Expected with the self-signed certificate (section 6). |
| An API call answers `403 sign_disabled` | **Secure Sign** is off for the workspace, or the workspace is suspended (section 2). A key cannot switch it on. |
| An API call answers `403 forbidden` | The key lacks `sign:read` (reads and downloads) or `sign:write` (create, send, remind, cancel). Make a new key with the scope; scopes cannot be added to an existing key (section 8b). |
| The API client retries and the merchant gets two documents | The call had no `reference`. With a `reference`, a retry returns the first document (`Idempotent-Replay: true`) and sends nothing. |

## 9a. A signed copy does not appear: find the real reason

The signer's page shows a spinner for two minutes, says "longer than usual", and after ten minutes stops spinning and says the copy will be emailed. The
sender's page says why (people with Secure Sign settings) and offers **Try again**. To read the same reasons on the server:

```bash
ssh root@YOUR-SERVER
cd /opt/wacrm

# the app's own log lines for sealing: the reason, then where it happened
docker compose --env-file .env.local logs --since 2h app | grep -E "\[sign\] (sealing|could not)"

# is the job running, and what did it say last? A 500 with seal_error in the body is a sealing failure; the Background jobs card shows the same
SECRET=$(grep "^AUTOMATION_CRON_SECRET=" .env.local | cut -d= -f2-)
curl -sS -H "x-cron-secret: $SECRET" https://YOUR-APP/api/sign/jobs-cron
```

```sql
-- the documents that are stuck, with the reason, the attempts used and when the last try was
select reference, title, status, seal_error, sealing_attempts, sealing_started_at
  from sign_documents where status in ('sealing', 'failed') order by sealing_started_at;
-- the history of one document (what each attempt said)
select created_at, type, detail from sign_events where document_id = '<document id>' and type like 'seal%' order by doc_seq;
```

Reasons and what they mean: `ENOENT ... NotoSans_...ttf` is the fonts missing from the image (they are traced into every `/api/sign/**` route by
`outputFileTracingIncludes` in `next.config.ts`: rebuild the image); `The sealing certificate ...` is the certificate (section 6; the document waits and is
sealed when a good one is installed); `could not claim documents to seal` or `permission denied` is the database (migration 158 must be applied);
`sensitive_unreadable` is the key ring (section 6a). Then press **Try again**.

**One link, one person.** In a collection each person has one link, and it opens only that person's own rows: a person is shown, and may answer, only the
places of their own role on each document (the server refuses any other key with `not_your_field`, and since migration 177 the database refuses it too).
A person who has signed everything of theirs reads "waiting for the others" until the other people have signed their documents; a document only they are on
is sealed at once, and its state is shown in the list, not as "everyone has signed". Two people on one role of a document are refused at send
(`role_shared`, or `role_two_people` in a collection).

## 9b. Which way email goes, and why a message did not arrive

For each message Secure Sign asks the workspace's connected mailboxes first: a Microsoft 365 mailbox that can send, else a Gmail mailbox that can send; a
mailbox that is switched off in Settings > Channels, or needs reconnecting, is skipped. With none ready, the platform sender (`RESEND_API_KEY`) is used.
With neither, the message is not sent and the person's row says so. There is no "primary email channel" setting: Microsoft 365 wins when both are connected.

**Settings > Secure Sign > General > Email** (people with Secure Sign settings) names the one in use, for example "Sent from support@vircle.com via your connected
Microsoft 365 mailbox", says when a connected mailbox cannot send and why the platform sender is used instead, links to where the mailbox is connected, and
**Send a test email to me** sends one short message to the signed-in person's own address the same way (five an hour). A test that fails shows the reason.

The reason of every message that did not arrive is kept on the document's history (`delivery_failed`, field `reason`) and shown to the sender on the
screen that sent it, on the person's row in the people list and in the toast of a resend. It is a word, then what the mail service said:

| Reason | Meaning |
|---|---|
| `not_set_up` | No connected mailbox and no `RESEND_API_KEY`. |
| `mailbox_reconnect` | Revoked or expired access (401, `invalid_grant`, consent withdrawn, a missing `Mail.Send` or `gmail.send` permission). The mailbox is marked "needs reconnecting" in its channel. |
| `mailbox_paused` | The channel is switched off in Settings > Channels. |
| `daily_limit` | The provider's sending limit for the day. |
| `rate_limited` | Throttled (HTTP 429, `MailboxConcurrency`, `ApplicationThrottled`, Gmail's per-second limit). One retry after the `Retry-After` the provider named (up to 15 seconds); longer than that, the mailbox is left alone for that long and each message in between fails at once with this reason. |
| `address_rejected` | The address is not valid or was refused. |
| `attachment_too_large` | The message with its files is over the provider's size limit (the files are normally left off and a link used before this happens). |
| `service_unavailable` | The provider could not be reached, or answered 5xx. |

Anything else shows what the provider said. A message accepted by the provider and bounced later is not known to Halo (the bounce goes to the mailbox).

## 9c. Mail Secure Sign sends is never read into the shared inbox

Mail sent through a connected mailbox can come back to Halo's own inbox ingestion: a message addressed to the mailbox itself (a test email, a copy to the
sender's own address) is delivered to its Inbox, and a bounce of a message Secure Sign sent arrives there too. The inbox is read by everyone with inbox access,
and these messages hold a person's signing link or a signed document, so Halo refuses them on the ingestion path, by independent signals:

- every Secure Sign message carries the header `X-Halo-Sign: 1` (the Microsoft 365 webhook reads it from `internetMessageHeaders`, the Gmail webhook from the
  message headers), and is refused when it has it;
- a delivery-failure notice that quotes the original's headers is refused when the quoted text has the header (Exchange puts them in the body; Gmail in a
  `text/rfc822-headers` part);
- Gmail only: the label `SENT` (Gmail's own statement that the mailbox sent it) is refused;
- a message from the mailbox's own address (`from` or `sender`) is refused.

Not covered: a person who replies to a Secure Sign email. The reply is an ordinary message from that person and becomes a conversation, quoting their own link
(set a Reply-To address in the workspace's email identity to send replies elsewhere). A bounce whose original headers the provider leaves out cannot be
recognised; it contains the recipient's address and the subject, not the link.
