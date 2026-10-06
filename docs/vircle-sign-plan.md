---
title: "Halo Sign: delivery plan"
subtitle: "Document 2 of 3 for review. Architecture, data, security, work packages and rollout, 6 Oct 2026"
---

# 1. Summary

Halo Sign is built natively inside Halo (decision: option B in the proposal). Nothing from the
OpenSign fork is copied; its behaviour is used as a reference only, so no AGPL obligation arises.
It is built in three phases behind an operator switch, first for Vircle only.

| Phase | Result | Effort (one engineer) |
|---|---|---|
| 0 | Decisions, legal read, certificate ordered | 3 days, overlaps phase 1 |
| 1 | An agent can send an agreement from a contact page, a merchant signs on a phone, the sealed PDF is filed | 35 days, about 7 weeks |
| 2 | Automation, API, webhooks, reminders, countersign in Halo, envelopes, bulk send | 23 days, about 4.5 weeks |
| 3 | Public registration form, trusted certificate, verify page, retention, hardening | 18 days, about 3.5 weeks |

These are planning figures. **Phase 1 is longer than the 5 to 6 weeks in the earlier proposal**,
because pricing the whole Halo checklist (four languages, permissions, export and deletion, CI
rules, audit) adds about a week. Phases can overlap with a second pair of hands.

# 2. What is reused from Halo, and what is new

| Need | Reuse | New |
|---|---|---|
| Tenancy | `accounts`, `account_id` plus row-level security | Sign tables |
| Roles | Capability system (`capabilities.ts`, role defaults, Roles screen) | `sign.*` permissions |
| Switch and limits | `account_platform` features and limits, usage meters | flag `sign`, limit `sign_documents_per_month` |
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

New dependencies, to be licence-checked before merge in WP2: **pdf-lib** (stamping), **pdfjs-dist**
(page rendering in the browser), **@signpdf/signpdf** with its pdf-lib placeholder and P12 signer
(PKCS7 sealing), **node-forge** (certificate handling), **signature_pad** (drawn signatures) and a QR
library for the certificate page. All are understood to be permissively licensed (MIT, BSD or
Apache); this is confirmed per package in WP2 and recorded in the repository.

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

# 4. Data model

All tables have `account_id uuid not null references accounts(id) on delete cascade`, row-level
security on, and `updated_at` triggers. Names start `sign_`. Migrations start at **157**.

| Table | Purpose | Key columns |
|---|---|---|
| `sign_templates` | A template's identity | name, description, status (draft, active, archived), current version, tags |
| `sign_template_versions` | Immutable version of a template | version no., source file path and SHA-256, page count, `fields` (json), `roles` (json), defaults (expiry, reminders, order, language, subject, message) |
| `sign_documents` | One document sent for signing | reference (SGN-2026-000123), title, status, template version (nullable), contact, ticket, deal, `merge_values`, `fields_snapshot`, sequential flag, locale, expires at, sent at, completed at, base file and SHA-256, final file and SHA-256, void reason, created by |
| `sign_document_files` | Files that belong to a document | kind (source, annex, signer upload, signed, certificate), path, name, size, SHA-256 |
| `sign_signers` | A person who signs | role key, name, email, phone, channel, order no., status, **token hash**, code hash and attempts, viewed, signed and declined times, decline reason, IP, device, locale, consent version |
| `sign_field_values` | What a signer entered | signer, field key, value (json) or file, sensitive flag, entered at |
| `sign_events` | **Append-only audit chain** | document, signer, type, actor (user, signer, system), detail (json), IP, device, `prev_hash`, `row_hash`, time |
| `sign_settings` | One row per workspace | default expiry, reminder days, default language, consent texts (per language), sender name, logo, retention years, certificate reference |
| `sign_certificates` | Sealing certificates | name, subject, valid until, **encrypted** P12 and passphrase, default flag |
| `sign_forms` (P3) | Public registration forms | slug, fields to contact mapping, template, automation, consent text |

**Document status:** `draft`, `sent`, `in_progress`, `sealing`, `completed`, `declined`, `expired`,
`voided`, `failed`. Allowed moves are enforced by a trigger, not only by the app.

**Signer status:** `pending`, `sent`, `viewed`, `signed`, `declined`.

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

# 6. Signer security

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

# 7. Where each part touches Halo

| Part | Files and conventions |
|---|---|
| Database | `supabase/migrations/157_sign_foundation.sql` onward, idempotent. CI: lines in `supabase/ci/platform-grants.sql`; `authenticated_ok` and bucket entries in `verify-guard-catalog.sql`; `verify-157-sign-*.sql` ending in `ROLLBACK-OK`. |
| Permissions | `capabilities.ts` (`menu.sign`, `sign.view`, `sign.send`, `sign.void`, `sign.templates`, `sign.settings`, `sign.sign`), `CapabilityKey`, `capabilities-sql.test.ts`, `capability-parity.test.ts`, role defaults in the migration. |
| Navigation | `sidebar.tsx` nav item, `page-access.ts`, `settings-sections.ts`. |
| Switch and limits | `features.ts` (`sign` in `PLATFORM_FEATURES`, `FEATURE_CAPABILITIES`, `sign_documents_per_month` in `PLATFORM_LIMITS`), `validate.ts`, `platform-console.tsx`, `usage.ts` (`assertCanSendDocument`), `account_usage()` and snapshots. |
| Seed function | `account_platform_seed()` is recreated in full, carrying `incidents`, `jira`, `vircle_chat` and `sign`. |
| Pages | `src/app/(dashboard)/sign/...` (list, templates, editor, document), public `src/app/sign/[token]/page.tsx`. |
| API | `src/app/api/sign/*` (staff, `requireCapability`), `src/app/api/sign/public/[token]/*` (token auth, listed in `PUBLIC_ROUTES` in `route-surface.test.ts`), `src/app/api/v1/sign/*` (P2). |
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

# 8. Work packages

## Phase 1 (35 days)

| WP | Work | Days |
|---|---|---|
| 1 | **Foundation:** tables, RLS, grants, bucket, append-only chain, permissions, switch, quota scaffolding, audit actions, export and deletion rules, verify scripts, parity tests | 5 |
| 2 | **PDF engine:** merge render, stamping, certificate pages, PKCS7 sealing, hashes, verification, golden test files checked with an independent verifier | 7 |
| 3 | **Template editor:** viewer, field placement and properties, roles, merge keys, versions, library, preview | 8 |
| 4 | **Send and sign:** wizard, recipients, invitations (email, WhatsApp), tokens and codes, signing page on mobile, signatures, uploads, decline, end states, seal job | 9 |
| 5 | **Management:** list, detail, audit view, contact tab, notifications, downloads, void, remind, resend | 4 |
| 6 | **Settings, platform and finish:** Settings, Platform console, four-language strings, User Guide, documentation, device testing | 2 |

## Phase 2 (23 days)

| WP | Work | Days |
|---|---|---|
| 7 | Automation trigger and step, webhooks, recipe "Merchant onboarding" | 4 |
| 8 | Public API `/api/v1/sign`, scopes, API docs | 3 |
| 9 | Reminders and expiry job, sequential signing polish, countersign inside Halo | 5 |
| 10 | Envelopes (several documents, one sitting) | 4 |
| 11 | Bulk send, CSV export, zip download | 3 |
| 12 | Sensitive-field encryption and masking, template test mode, ticket and deal attach | 4 |

## Phase 3 (18 days)

| WP | Work | Days |
|---|---|---|
| 13 | Public registration forms and anti-abuse | 6 |
| 14 | CA-issued certificate rollout, verify page | 5 |
| 15 | Retention rules and the deletion exception | 3 |
| 16 | Load test, security review, fixes | 4 |

# 9. Testing

- **Unit tests (Vitest):** tokens and codes, state moves, merge rendering, field validation, hash
  chain, sealing steps, permissions.
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

# 10. Rollout

1. Build behind the `sign` switch, off for everyone.
2. Switch on for the Vircle workspace and use test documents.
3. **Pilot** with three merchants. Fix what they hit.
4. Open to all Vircle users, then enable Phase 2 automation.
5. Decide whether to offer to customers; that is a switch plus pricing, not new code.

**Deployment.** No new container. A migration, a redeploy of Halo, and one crontab line. The VPS size
is not recorded anywhere, so measure memory and CPU of one seal job in WP2 and report; if sealing
needs headroom, the engine moves to a small worker container on the same host (the gateway pattern).

# 11. Risks

| Risk | Effect | Handling |
|---|---|---|
| Legal weight of the signature for merchant contracts in Malaysia | A contract could be challenged | Phase 0 legal read; decide if a licensed certificate is required at launch; consent and audit trail from day one |
| Certificate procurement is slow | Trusted signature arrives late | Order in Phase 0; Phase 1 uses an organisational certificate |
| PDF stamping uses CPU and memory | Slows Halo | Queue, 2 at a time, measure in WP2, worker container as fallback |
| Phone browsers differ (drawing, upload, zoom) | Merchants cannot sign | Device matrix; typed signature as an alternative |
| WhatsApp template approval | Invitations by WhatsApp delayed | Email works from day one; submit the template in Phase 0 |
| Retention versus workspace deletion | Either contracts lost or deletion promise broken | Decision needed now (question 6 in the feature document) |
| Scope growth (editor features) | Delays | Phase gates; "Later" list in document 1 |
| Library licences or maintenance | Rework | Checked in WP2 and recorded |

# 12. Decisions needed before Phase 1 starts

1. The assumptions in the feature document, section 1.
2. First template: the actual agreement and its fields (feature document, questions 2 and 3).
3. Countersigner and order (question 4).
4. Retention period and the deletion exception (question 6).
5. Certificate: who orders it, and whether a CA-issued one is mandatory at launch.
6. VPS memory and CPU figures, or permission to measure them.
