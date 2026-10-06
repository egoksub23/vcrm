---
title: "Vircle Doc Sign: delivery plan"
subtitle: "Document 2 of 3 for review. Architecture, data, security, work packages and rollout, revised 6 Oct 2026"
---

# 1. Summary

Vircle Doc Sign is built natively inside Halo (decision: option B in the proposal). It signs **any
document** (PDF, Word, image), supports a signing list with an optional signing order, and groups
documents into categories. Ready-made packs, starting with **Merchant Registration**, come as
add-ons. Nothing from the OpenSign fork is copied; its behaviour is used as a reference only, so no
AGPL obligation arises. It is built in three phases behind an operator switch, first for Vircle only.

| Phase | Result | Effort (one engineer) |
|---|---|---|
| 0 | Decisions, legal read, certificate ordered | 3 days, overlaps phase 1 |
| 1 | Any PDF, Word file or image can be prepared and sent to a signing list (in order if chosen); a merchant signs on a phone; the sealed PDF is filed; the Merchant Registration add-on is installable | 46 days, about 9 weeks |
| 2 | Automation, API, webhooks, reminders, countersign in Halo, envelopes, bulk send, add-on updates | 25 days, about 5 weeks |
| 3 | Public registration form, trusted certificate, verify page, retention, hardening | 18 days, about 3.5 weeks |

These are planning figures. **Phase 1 grew from 35 to 46 days** after your note on Word files,
categories and add-ons, and the signing list: Word conversion service 4 days, categories and
add-ons 4, wider field types and the prepare-any-document path 2, signing-order logic 1. (The 35
days were already longer than the 5 to 6 weeks in the earlier proposal, because pricing the whole
Halo checklist adds about a week.) Phases can overlap with a second pair of hands.

# 2. What is reused from Halo, and what is new

| Need | Reuse | New |
|---|---|---|
| Tenancy | `accounts`, `account_id` plus row-level security | Sign tables |
| Roles | Capability system (`capabilities.ts`, role defaults, Roles screen) | `sign.*` permissions |
| Switch and limits | `account_platform` features and limits, usage meters | flags `sign` and `sign_merchant`, limit `sign_documents_per_month` |
| Files | Private storage with signed URLs, existing storage meter | bucket `sign-documents` |
| Email | Resend client and per-workspace sender identity | invitation, reminder, completed emails |
| WhatsApp | `sendMessageToConversation` / template sending helpers | invitation template |
| Contacts | contacts, custom fields, timeline, notifications | Documents tab, events |
| Automation | engine (`runAutomationsForTrigger`, `runStep`) | trigger and step |
| Integration | outbound webhooks, `/api/v1`, API keys and scopes | events and routes |
| Secrets | key ring and `ENCRYPTED_COLUMNS` | certificate and sensitive fields |
| Audit | `audit_log`, append-only pattern, file hashes from incidents | `sign_events` chain |
| Export and deletion | table discovery, storage by prefix | retention exception |
| Rate limits, client IP | `rate_limit_hit`, trusted-proxy rule | signer endpoints |
| Word to PDF | none | conversion service (container) |
| Custom contact fields | `custom_fields` | fields installed by an add-on |

New dependencies, to be licence-checked before merge in WP2: **pdf-lib** (stamping), **pdfjs-dist**
(page rendering in the browser), **@signpdf/signpdf** with its pdf-lib placeholder and P12 signer
(PKCS7 sealing), **node-forge** (certificate handling), **signature_pad** (drawn signatures) and a QR
library for the certificate page. All are understood to be permissively licensed (MIT, BSD or
Apache); this is confirmed per package in WP2 and recorded in the repository. Word conversion uses
**Gotenberg**, an open-source (MIT) service that runs LibreOffice in the background, as a separate
container; LibreOffice keeps its own licence and is not modified or linked into Halo.

# 3. Architecture

```
 Sender (Halo UI)                          Signer (public page, no login)
      |                                              |
      v                                              v
 /sign/*  dashboard pages            /sign/[token]   public signing page
 /api/sign/*  (requireCapability)    /api/sign/public/[token]/*  (token auth)
      |                                              |
      +----------- src/lib/sign/*  (shared logic) ---+
           |            |             |            |
        templates    ceremony      pdf engine    notifications
           |            |             |            |
           v            v             v            v
        Postgres (RLS)   Storage (private)   Resend / WhatsApp / automations / webhooks
```

- **Where it runs.** Inside the existing Halo container: pages, API routes and the PDF engine. The
  engine is plain TypeScript with no framework imports, so it can move to its own worker container
  later if load needs it, without a rewrite.
- **Background work.** Sealing, reminders and expiry run as leased jobs (the pattern from migration
  135) driven by one cron route, `/api/sign/jobs-cron`, every minute. Sealing is queued, not done in
  the signer's request, with at most 2 at once.
- **No second database.** All state is in Halo's Postgres. All files are in Halo's storage.
- **One new container.** The conversion service (section 6), reachable only from the Halo container.

# 4. Data model

All tables have `account_id uuid not null references accounts(id) on delete cascade`, row-level
security on, and `updated_at` triggers. Names start `sign_`. Migrations start at **157**.

| Table | Purpose | Key columns |
|---|---|---|
| `sign_categories` | A document category | key, name, defaults (expiry, reminders, code required, sign in order, consent wording, retention), add-on key (if installed by one), archived |
| `sign_addons` | Which add-ons a workspace has installed | add-on key, installed version, installed by and when, status |
| `sign_templates` | A template's identity | name, description, **category**, status (draft, active, archived), current version, tags, add-on key and version if it came from one, "customised" flag |
| `sign_template_versions` | Immutable version of a template | version no., source file path and SHA-256, page count, `fields` (json), `roles` (json), defaults (expiry, reminders, order, language, subject, message) |
| `sign_documents` | One document sent for signing | reference (SGN-2026-000123), title, status, **category**, template version (nullable), contact, ticket, deal, `merge_values`, `fields_snapshot`, **`sign_in_order` flag**, locale, expires at, sent at, completed at, **original upload (path, type, SHA-256)**, **converted PDF**, base file and SHA-256, final file and SHA-256, void reason, created by |
| `sign_document_files` | Files that belong to a document | kind (source, annex, signer upload, signed, certificate), path, name, size, SHA-256 |
| `sign_signers` | A person who signs | role key, **full name**, **email**, phone, channel, **order number (step)**, **invited at**, status, **token hash**, code hash and attempts, viewed, signed and declined times, decline reason, IP, device, locale, consent version |
| `sign_field_values` | What a signer entered | signer, field key, value (json) or file, sensitive flag, entered at |
| `sign_events` | **Append-only audit chain** | document, signer, type, actor (user, signer, system), detail (json), IP, device, `prev_hash`, `row_hash`, time |
| `sign_settings` | One row per workspace | default expiry, reminder days, default language, consent texts (per language), sender name, logo, retention years, certificate reference |
| `sign_certificates` | Sealing certificates | name, subject, valid until, **encrypted** P12 and passphrase, default flag |
| `sign_forms` (P3) | Public registration forms | slug, fields to contact mapping, template, automation, consent text |

**Document status:** `draft`, `sent`, `in_progress`, `sealing`, `completed`, `declined`, `expired`,
`voided`, `failed`. Allowed moves are enforced by a trigger, not only by the app.

**Signer status:** `pending`, `sent`, `viewed`, `signed`, `declined`.

**Signing order.** Each signer has an order number; signers sharing a number are one *step*. With
`sign_in_order` off, every step is invited at once and the numbers are ignored. With it on:

1. Only step 1 is invited when the document is sent. Later signers have a link from the start but
   it opens only a "waiting for {name}" page with no document content.
2. When a signer finishes, the server locks the document row, checks whether every signer in the
   step is done, and if so invites the next step in the same transaction. A unique record per
   document and step makes the invitation happen once even if two signers finish at the same moment.
3. A decline, a void or an expiry stops the chain. Reminders go only to the current step.
4. The last step finishing moves the document to sealing.
The whole thing is tested with parallel, sequential, mixed and racing cases.

```
draft -> sent -> in_progress -> sealing -> completed
              \-> declined      \-> failed (retry)
              \-> expired
 any non-final state -> voided
```

**The audit chain.** `sign_events.row_hash = sha256(prev_hash || canonical row)`. A database trigger
computes it under a per-document lock, and update and delete are blocked, using the same
append-only pattern as Halo's audit log. A function `sign_verify_chain(document)` recomputes the
chain; the Document detail screen shows "Audit trail intact" from it.

**Not stored in plain text:** link tokens and codes (hashes only); the certificate and its
passphrase (encrypted, key ring); fields marked sensitive (encrypted, P2).

# 5. Files and the sealing pipeline

**Storage.** Private bucket `sign-documents`, path `account-<id>/<document>/<kind>/<name>`. Signed-in
members can read their own workspace's objects only through server-made signed links; nobody has
insert, update or delete rights from the browser. Only the server writes. The existing storage meter
already counts anything under `account-<id>/` in any bucket.

**Pipeline.**

1. **Freeze (on send).** The server writes merge values onto the template PDF, saves it as the
   *base* file, records its SHA-256, and snapshots the field definitions into the document. From now
   on the template can change without affecting this document.
2. **Each signer.** The server validates every value (type, required, pattern, size), stores it, and
   appends events. The browser only collects input.
3. **Seal (when the last signer finishes).** A queued job loads the base PDF, draws every value and
   signature image, appends the **completion certificate** pages (document id, SHA-256 of the
   content, every signer's details, times, devices, verification, consent), adds a QR code to the
   verify page (P3), applies a **PKCS7 signature** with the workspace's certificate, saves the final
   file, records its SHA-256, writes events, marks the document completed and sends the emails.
4. **Download.** Every download re-computes the SHA-256 and compares it with the stored value; a
   mismatch blocks the download and raises an alert.
5. **Idempotent.** The seal job is keyed by document, so a retry after a crash cannot seal twice.

**Certificate.** Phase 1 uses an organisational certificate, held encrypted, that signs every sealed
file. PDF readers show the signature as intact but not yet "trusted" until Phase 3 replaces it with a
certificate from a recognised certificate authority. Procurement takes time, so it is ordered in
Phase 0.

# 6. Word conversion and preparing any document

**Why a service.** A faithful Word to PDF conversion needs a full layout engine. The service is
Gotenberg (LibreOffice inside), run as a container beside Halo.

- **Network.** Halo calls it at a fixed address set by `SIGN_CONVERTER_URL`. The container has no
  route to the internet and no published port. Halo's outbound guard refuses private addresses by
  design, so the converter client is a separate, trusted client that only ever calls this one
  configured address; no workspace or user can set it.
- **Safety.** Uploaded Word files are untrusted. Macros never run during conversion. The container
  is non-root, read-only except a temporary folder, limited to about 1 GB of memory and one or two
  conversions at once, with a 60-second limit. The result is checked to be a real PDF, within the
  page limit, before it is accepted. The Word file is never sent to a signer, only the converted PDF.
- **Fidelity.** Standard fonts convert closely (Arial, Times New Roman and Courier New are matched
  by metric-compatible fonts). Fonts the converter does not have are replaced, which can move text.
  Vircle's own fonts are added to the converter image. Tracked changes and comments should be
  cleared before upload (the upload screen says so). The editor always shows the converted pages with
  "This is exactly what will be signed", and the sender can replace the file or upload a PDF instead.
- **Images.** JPG and PNG become one-page PDFs inside Halo, with no converter.
- **If the converter is down.** Word upload shows "Word conversion is not available right now.
  Upload a PDF instead." Everything else keeps working. The Platform console job card shows its health.
- **Cost.** The image is large (on the order of 1 GB or more) and peak memory while converting is
  several hundred MB. Both are measured in WP3 and added to the weekly cleanup notes.

**Prepare any document.** The field editor is one component used three ways: editing a template,
preparing a template-based document (values only), and preparing an **uploaded** document (full
placement). From the wizard or from a contact, a sender uploads a file, the editor opens on its
pages, and "Save as template" copies the prepared fields into a template at any moment.

# 7. Categories and add-ons

- **Categories** are plain rows with defaults (section 4). A document's effective settings are the
  category's defaults over the workspace's, then any choice made on the document itself.
- **Add-ons** are defined in the code base, versioned, and contain a category, template source files
  (PDF or Word), custom contact field definitions, wording in the supported languages and, later, an
  automation recipe and a registration form. They live in `src/lib/sign/addons/<key>/`.
- **Operator switch.** Whether a workspace may use an add-on is a platform feature flag
  (`sign_merchant` for Merchant Registration), off for new workspaces, on for Vircle.
- **Install.** A workspace Owner or Admin presses Install. One transaction creates the category,
  creates the templates as drafts to review, creates any missing contact fields, and records the
  installed version. It can be repeated safely and never overwrites anything the workspace changed:
  an edited add-on template is marked "customised" and an update only offers a new version beside it.
- **Update (Phase 2).** A new add-on version shows "Update available" with a change list.

# 8. Signer security

- **Link:** 32 random bytes, only its SHA-256 stored, shown once. Reissuing a link kills the old one.
- **Code:** 6 digits, hashed, 10 minutes, 5 tries, then locked for 15 minutes; resends are limited.
- **Rate limits:** per link, per network address and per workspace, using Halo's shared limiter. The
  address comes from the trusted-proxy rule already used elsewhere.
- **Pages:** signing pages are served `no-store`, with no search indexing, and do not reveal whether
  a link ever existed (a wrong link and an expired link look different only to the signer who has the
  right one).
- **Files:** the document is streamed through a route that checks the link on every request; storage
  addresses are never handed to the browser.
- **Cross-tenant:** signer routes use the service role, so they are written to look up by token hash
  only and to return only that signer's document. A test asserts that a token never reads another
  document's data.
- **Signer uploads:** type and size checked, stored under the document, scanned by type only (no
  macros possible in the allowed types).
- **Staff access:** reading requires `sign.view`; writes happen only through server routes that call
  `requireCapability`; the audit log records administrative changes.

# 9. Where each part touches Halo

| Part | Files and conventions |
|---|---|
| Database | `supabase/migrations/157_sign_foundation.sql` onward, idempotent. CI: lines in `supabase/ci/platform-grants.sql`; `authenticated_ok` and bucket entries in `verify-guard-catalog.sql`; `verify-157-sign-*.sql` ending in `ROLLBACK-OK`. |
| Permissions | `capabilities.ts` (`menu.sign`, `sign.view`, `sign.send`, `sign.void`, `sign.templates`, `sign.settings`, `sign.sign`), `CapabilityKey`, `capabilities-sql.test.ts`, `capability-parity.test.ts`, role defaults in the migration. |
| Navigation | `sidebar.tsx` nav item, `page-access.ts`, `settings-sections.ts`. |
| Switch and limits | `features.ts` (`sign` and `sign_merchant` in `PLATFORM_FEATURES`, `FEATURE_CAPABILITIES`, `sign_documents_per_month` in `PLATFORM_LIMITS`), `validate.ts`, `platform-console.tsx`, `usage.ts` (`assertCanSendDocument`), `account_usage()` and snapshots. |
| Seed function | `account_platform_seed()` is recreated in full, carrying `incidents`, `jira`, `vircle_chat`, `sign` and `sign_merchant`. |
| Pages | `src/app/(dashboard)/sign/...` (list, templates, editor, document), public `src/app/sign/[token]/page.tsx`. |
| API | `src/app/api/sign/*` (staff, `requireCapability`), `src/app/api/sign/public/[token]/*` (token auth, listed in `PUBLIC_ROUTES` in `route-surface.test.ts`), `src/app/api/v1/sign/*` (P2). |
| Conversion | `docker-compose.sign.yml` (converter service, internal network), `SIGN_CONVERTER_URL`, converter client in `src/lib/sign/convert/`, health on the Platform job card. |
| Add-ons | `src/lib/sign/addons/merchant/` (manifest, template files, fields, wording), installer route, Settings > Doc Sign > Add-ons. |
| Jobs | `/api/sign/jobs-cron` through `cronRoute`, `CRON_INTERVALS`, Platform job card string, crontab line in `docs/automations-and-cron.md`. |
| Engine | `src/lib/sign/` (`pdf/`, `ceremony/`, `tokens.ts`, `events.ts`, `templates/`, `notify.ts`). |
| Notifications | notification types widened in the migration; email templates beside `invitation-email.ts`. |
| Automation | `AutomationTriggerType`, `TRIGGER_META`, builder, `validate.ts`, `engine.ts`, a step in `runStep` (P2). |
| Webhooks | `WEBHOOK_EVENTS` entries `sign.sent`, `sign.viewed`, `sign.completed`, `sign.declined`, `sign.expired` (P2). |
| Audit | new actions and entity types in `src/lib/audit/types.ts` and the check constraint. |
| Export and deletion | tables discovered automatically; list `sign_events` children if needed; the retention exception; teardown has no external registrations. |
| Contacts | `merge_contacts()` repoint for `sign_documents.contact_id`; soft-delete behaviour reviewed. |
| Language and guide | `Sign` namespace in four languages, `content/help/sign/*`, neutral-wording test, `CHANGELOG.md`, version bump 0.76.0. |
| Public registration address | the signer page and verify page added to `registered-urls.ts` only if a provider needs it (no). |

# 10. Work packages

## Phase 1 (46 days)

| WP | Work | Days |
|---|---|---|
| 1 | **Foundation:** tables (including categories, add-ons, signing steps), RLS, grants, bucket, append-only chain, permissions, switches, quota scaffolding, audit actions, export and deletion rules, verify scripts, parity tests | 5 |
| 2 | **PDF engine:** merge render, stamping of every field type, certificate pages, PKCS7 sealing, hashes, verification, golden test files checked with an independent verifier | 7 |
| 3 | **Conversion service:** container and compose file, converter client, size, time and page checks, preview and error messages, fonts, image-to-PDF, tests with a set of real Word files | 4 |
| 4 | **Editor:** viewer, field placement and properties for all field types, roles, merge keys, versions, library, preview, prepare-any-document path, save as template | 10 |
| 5 | **Send and sign:** wizard, **signing list with full name, email and order**, order logic, invitations (email, WhatsApp), tokens and codes, signing page on mobile, signatures, uploads, decline, waiting and end states, seal job | 10 |
| 6 | **Management:** list with category filter, detail, audit view, contact tab, notifications, downloads, void, remind, resend, change recipient | 4 |
| 7 | **Categories and add-ons:** category settings, add-on catalogue and installer, Merchant Registration content, operator switch | 4 |
| 8 | **Settings, platform and finish:** Settings, Platform console, four-language strings, User Guide, documentation, device testing | 2 |

## Phase 2 (25 days)

| WP | Work | Days |
|---|---|---|
| 9 | Automation trigger and step, webhooks, recipe "Merchant onboarding" | 4 |
| 10 | Public API `/api/v1/sign`, scopes, API docs | 3 |
| 11 | Reminders and expiry job, countersign inside Halo | 5 |
| 12 | Envelopes (several documents, one sitting) | 4 |
| 13 | Bulk send, CSV export, zip download | 3 |
| 14 | Sensitive-field encryption and masking, template test mode, ticket and deal attach, replace file, add-on updates | 6 |

## Phase 3 (18 days)

| WP | Work | Days |
|---|---|---|
| 15 | Public registration forms and anti-abuse | 6 |
| 16 | CA-issued certificate rollout, verify page | 5 |
| 17 | Retention rules and the deletion exception | 3 |
| 18 | Load test, security review, fixes | 4 |

# 11. Testing

- **Unit tests (Vitest):** tokens and codes, state moves, merge rendering, field validation, hash
  chain, sealing steps, permissions, and the signing-order logic (parallel, sequential, mixed steps,
  two signers finishing at once, decline mid-chain, change recipient mid-chain).
- **Conversion tests:** a set of real Word files (tables, images, headers, tracked changes, Malay text,
  large and corrupt files) converted and compared page by page; oversized and macro-laden files
  rejected or neutralised.
- **Database checks:** `verify-157` and later scripts for row-level security, chain integrity,
  blocked updates, cascade, quota; run in CI against an empty database and against production
  (rolled back) before each migration is applied.
- **PDF proof:** sealed golden files verified by an independent tool (for example `pdfsig` or an
  OpenSSL check) in CI where available and by hand in common PDF readers before each release.
- **Security tests:** token guessing and reuse, replay after reissue, cross-workspace reads,
  oversized and wrong-type uploads, rate limits.
- **Device matrix before the pilot:** iPhone Safari, Android Chrome, one low-end Android, a desktop
  browser, each in English and Bahasa Melayu; keyboard-only and screen-reader pass.
- **Pilot:** three real merchants, with the owner watching events live.

# 12. Rollout

1. Build behind the `sign` switch, off for everyone.
2. Switch on for the Vircle workspace and use test documents.
3. **Pilot** with three merchants. Fix what they hit.
4. Open to all Vircle users, then enable Phase 2 automation.
5. Decide whether to offer to customers; that is a switch plus pricing, not new code.

**Deployment.** One new container (the converter), a migration, a redeploy of Halo, and one crontab
line. The VPS size is not recorded anywhere, so measure memory and CPU of one seal job in WP2 and of
one conversion in WP3 and report; if either needs headroom, the engine moves to a small worker
container on the same host (the gateway pattern).

# 13. Risks

| Risk | Effect | Handling |
|---|---|---|
| Legal weight of the signature for merchant contracts in Malaysia | A contract could be challenged | Phase 0 legal read; decide if a licensed certificate is required at launch; consent and audit trail from day one |
| Certificate procurement is slow | Trusted signature arrives late | Order in Phase 0; Phase 1 uses an organisational certificate |
| PDF stamping uses CPU and memory | Slows Halo | Queue, 2 at a time, measure in WP2, worker container as fallback |
| Word files convert imperfectly (fonts, layout) | The signed document differs from what the author saw | Preview with "this is exactly what will be signed", Vircle fonts added, PDF recommended for exact layout |
| Converter handles untrusted files | Attack surface | Isolated container with no internet, resource limits, result validation, never served back |
| Phone browsers differ (drawing, upload, zoom) | Merchants cannot sign | Device matrix; typed signature as an alternative |
| WhatsApp template approval | Invitations by WhatsApp delayed | Email works from day one; submit the template in Phase 0 |
| Retention versus workspace deletion | Either contracts lost or deletion promise broken | Decision needed now (question 6 in the feature document) |
| Scope growth (editor features) | Delays | Phase gates; "Later" list in document 1 |
| Library licences or maintenance | Rework | Checked in WP2 and recorded |

# 14. Decisions needed before Phase 1 starts

1. The assumptions in the feature document, section 1.
2. First template: the actual agreement and its fields (feature document, questions 2 and 3).
3. Countersigner and order (question 4).
4. Retention period and the deletion exception (question 6).
5. Certificate: who orders it, and whether a CA-issued one is mandatory at launch.
6. VPS memory and CPU figures, or permission to measure them.
7. The merchant agreement as Word and PDF, with its fonts, so conversion can be tested on the real file.
8. Brand name on customer-facing wording while the module is Vircle-only (the help pages for it are owner-only so Halo's neutral-wording test still passes).
