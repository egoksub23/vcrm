---
title: "Halo Sign: feature set"
subtitle: "Document 1 of 3 for review. Requirements, scope and acceptance, 6 Oct 2026"
---

# 1. Purpose and how to review this document

Halo Sign is a native document-signing module inside Halo. It lets a workspace turn a form or
contract into a template, send it to one or more people for electronic signature, store the signed
result safely, and manage documents afterwards. The first use is **merchant registration**: a
merchant applies, receives an agreement prefilled with their details, signs on their phone, and the
signed file lands on their record in Halo with no manual handling.

Each requirement has an id (F-01 and so on) so you can reply "change F-14" or "drop F-22". Priority:

- **P1** first release (Phase 1), enough to run real merchant agreements.
- **P2** second release (Phase 2), automation, API and scale.
- **P3** third release (Phase 3), forms, trusted certificate, hardening.
- **Later** parked, not planned.

**Assumptions made so work can start (please confirm or change):**

1. First release is **Vircle only**: an operator switch `sign`, off for new workspaces and on for
   Vircle, like Jira and Incident Reporting. The design is multi-tenant from day one, so offering it
   to customers later is switching it on.
2. Signers use **email or WhatsApp** links; no SMS.
3. Signer languages at launch: **English and Bahasa Melayu**. Halo's Korean and Chinese files are
   also used for the signer page, because the strings already exist in the Halo language setup.
4. Input is **PDF only**. Word files are not accepted in v1 (convert before uploading).
5. The signature is an **advanced electronic signature with audit trail** under an organisational
   certificate. A licensed certificate-authority signature is a P3 option, pending legal advice.
6. Signed documents are **kept for a configurable period** (proposed default 7 years), even if the
   workspace is deleted, as an explicit exception. This needs your decision.

# 2. Who uses it

| Person | What they do | Where |
|---|---|---|
| **Sender** (onboarding or sales agent) | Sends documents, follows progress, resends, voids | Halo, Sign section and contact page |
| **Template owner** (operations lead) | Builds and versions templates, fixes field positions and merge keys | Halo, Sign > Templates |
| **Signer** (merchant, no account) | Opens a link, reviews, fills fields, signs, downloads a copy | A public page on a phone or computer |
| **Countersigner** (Vircle director) | Signs after the merchant, inside Halo | Halo, "Awaiting my signature" |
| **Reviewer** (compliance, audit) | Reads the audit trail, verifies a document is untampered | Halo and the public verify page |
| **Platform operator** | Switches the module on, sets monthly limits, sees usage | Halo Platform console |

# 3. Feature list

## 3.1 Templates

| Id | Requirement | Pri |
|---|---|---|
| F-01 | Upload a PDF as a template (up to 25 MB, 50 pages). Reject password-protected or corrupt files with a clear message. | P1 |
| F-02 | Field editor: click or drag on a page to place fields; move, resize, copy, align, delete; keyboard nudging; page thumbnails; zoom. | P1 |
| F-03 | Field types: signature, initials, full name, date signed (automatic), text, multi-line text, email, phone, number, checkbox, dropdown, radio group, **file upload by signer** (for example business registration certificate, ID copy). | P1 |
| F-04 | **Signer roles** per template (for example Merchant, Vircle Director). Each field belongs to a role. Up to 6 roles. | P1 |
| F-05 | Field properties: required or optional, label and help text, placeholder, default value, validation (length, email, phone, a regular expression such as an IC number), read-only. | P1 |
| F-06 | **Merge fields**: a field can be filled before sending from a contact or workspace value (name, email, phone, company, country, any custom field, document reference, today's date). Merge keys are chosen from a list, not typed. | P1 |
| F-07 | Template **versions**: editing a template used by sent documents creates a new version. A document always keeps the exact version it was sent with. | P1 |
| F-08 | Template defaults: signing order (parallel or in sequence), expiry in days, reminder schedule, email subject and message, which language to open in. | P1 |
| F-09 | Template library: search, tags, archive and restore, duplicate, preview as a signer, who changed what and when. | P1 |
| F-10 | Template test mode: send yourself a preview document that is clearly marked TEST and does not count toward limits. | P2 |
| F-11 | Conditional fields (show a field only if another is ticked). | Later |

## 3.2 Creating and sending a document

| Id | Requirement | Pri |
|---|---|---|
| F-12 | New document from a template through a short wizard: choose template, add recipients, check prefilled values, review, send. | P1 |
| F-13 | **New document from the contact page**: the contact is chosen already and recipients and merge values are prefilled from the contact. | P1 |
| F-14 | Recipients: name, email, phone, role, channel (email, WhatsApp or both) and order. A recipient can be a Halo contact. | P1 |
| F-15 | One-off document: upload a PDF and place fields without saving a template. | P1 |
| F-16 | Annexes: attach extra files to the document (read-only, listed in the signing page and included in the sealed packet). | P1 |
| F-17 | Send now or save as draft; resend; change a recipient's email or phone and reissue the link (the old link stops working). | P1 |
| F-18 | Envelope: several documents signed in one sitting (for example Agreement + Fee schedule + Data processing terms), one audit trail. | P2 |
| F-19 | Bulk send: choose many contacts or upload a CSV, one document each, with a preview and a per-row result. | P2 |
| F-20 | Schedule a send for later. | Later |

## 3.3 Invitations and reminders

| Id | Requirement | Pri |
|---|---|---|
| F-21 | Invitation by email using the workspace's sender identity (name and reply-to), with the message, a button and the expiry date. | P1 |
| F-22 | Invitation by WhatsApp using an approved template message that carries the link. Counts toward the monthly message limit. | P1 |
| F-23 | Next signer is notified automatically when the previous one finishes (sequential signing). | P1 |
| F-24 | Automatic reminders on a schedule (for example day 3 and day 7) and an expiry date. Reminders stop when the document is completed, declined, voided or expired. | P2 |
| F-25 | Manual "Remind now" with a rate limit (once per 24 hours per signer). | P1 |
| F-26 | Copies: cc and bcc on completion; sender and chosen Halo users are notified in Halo when a document is viewed, signed, declined or expired. | P1 |

## 3.4 The signing experience (no login)

| Id | Requirement | Pri |
|---|---|---|
| F-27 | A private one-time link per signer; the page works on a phone first, and on tablets and computers. | P1 |
| F-28 | Optional **verification code** (6 digits by email or WhatsApp, 10 minutes, 5 tries) before the document opens. Set per template or per document. | P1 |
| F-29 | Language picker on the page (English, Bahasa Melayu; Korean and Chinese available). Defaults to the contact's or workspace language. | P1 |
| F-30 | **Consent to electronic signing** shown before the first signature, in the signer's language. The wording, version and time of consent are stored. | P1 |
| F-31 | Guided filling: progress ("3 of 5 required fields done"), a Next button that jumps to the next unfinished field, and clear errors on the field. | P1 |
| F-32 | Adopt a signature by **drawing**, **typing** (several script styles) or **uploading an image**; the same choice can be reused for initials. | P1 |
| F-33 | The signer sees what earlier signers already completed. They can **download the document** at any time (unsigned or in-progress copy), and the **signed copy** when finished. | P1 |
| F-34 | **Decline** with a reason. The sender is told and the document stops. | P1 |
| F-35 | Save and resume: a signer who closes the page can return to the same link and continue until it expires. | P1 |
| F-36 | Friendly end states: finished (with download), already signed, declined, expired, voided, link replaced. None reveal any other document's data. | P1 |
| F-37 | Accessibility: keyboard use, screen-reader labels, contrast, zoom to 200 percent, typed-signature alternative to drawing. | P1 |
| F-38 | Signer can sign from inside Halo when they are a Halo user (a **countersigner**): "Awaiting my signature" list, same page, identity taken from their login. | P2 |

## 3.5 Sealing, storage and proof

| Id | Requirement | Pri |
|---|---|---|
| F-39 | When the last signer finishes, the **server** places every field on the PDF, appends a **completion certificate** page, applies a cryptographic signature and stores the result. The browser is never trusted for the final file. | P1 |
| F-40 | The completion certificate lists: document id, title, SHA-256 of the sealed file, sender, every signer (name, email, role), when each viewed and signed, network address and device, how each was verified, and the consent version. | P1 |
| F-41 | **Audit trail** of every event (created, sent, delivered, viewed, code verified, field filled, signed, declined, reminded, voided, downloaded, expired). It cannot be edited or deleted, and each entry is chained to the previous by a hash so tampering is detectable. | P1 |
| F-42 | Originals and signed files are stored in a **private** store users cannot overwrite or delete. Size and hash are recorded when written and checked when downloaded. | P1 |
| F-43 | Signed copy and certificate emailed to every signer and the sender on completion. | P1 |
| F-44 | **Verify a document**: a public page where anyone uploads a PDF or enters its reference and sees whether it matches a sealed document (date, signers' names). | P3 |
| F-45 | Trusted certificate from a certificate authority so PDF readers show the signature as valid without warnings. | P3 |
| F-46 | Retention: a workspace setting (years). A document is not removable before its retention date, even by the owner. A deliberate exception applies on workspace deletion (see section 6). | P3 |
| F-47 | Sensitive fields (ID numbers, bank details): masked on screen, stored encrypted, left out of exports and API unless asked for. | P2 |

## 3.6 Managing documents

| Id | Requirement | Pri |
|---|---|---|
| F-48 | Document list: status (Draft, Sent, In progress, Completed, Declined, Expired, Voided), search by title, reference or signer, filters (template, sender, contact, date), sort, counts per status. | P1 |
| F-49 | Document detail: progress per signer, field values, files, the audit trail, and actions: remind, resend, change recipient, void (with reason), duplicate, download, copy link. | P1 |
| F-50 | Contact page tab **Documents**: every document for that contact, with a button to send a new one. Events also appear on the contact's timeline. | P1 |
| F-51 | Attach a document to a **ticket** or **deal**; shows on that record. | P2 |
| F-52 | "Awaiting my signature" and "Needs attention" (declined, expired, bounced email) shortcuts at the top of the list. | P1 |
| F-53 | Export a list to CSV; download many signed files as a zip. | P2 |

## 3.7 Automation and integration

| Id | Requirement | Pri |
|---|---|---|
| F-54 | Automation **step** "Send for signature": choose a template, map the contact to a role, set channel and merge values. | P2 |
| F-55 | Automation **triggers**: document sent, viewed, completed, declined, expired. | P2 |
| F-56 | **Outbound webhooks** for the same events, signed like Halo's other webhooks, so the merchant backend can react. | P2 |
| F-57 | **Public API** under `/api/v1/sign` with scopes `sign.read` and `sign.write`: create from template with signers and merge values, list, get, void, download. | P2 |
| F-58 | A **registration form** page (public) whose answers create or update a contact and start an automation, for example merchant onboarding. | P3 |
| F-59 | Merchant onboarding recipe shipped as an automation template (see section 5). | P2 |

## 3.8 Administration

| Id | Requirement | Pri |
|---|---|---|
| F-60 | Roles and permissions (section 7). The Sign menu is hidden from people who hold none of them. | P1 |
| F-61 | Settings > Sign: defaults (expiry, reminders, language), consent wording per language, sender name for invitations, brand logo shown on the signer page, certificate, retention. | P1 |
| F-62 | Operator switch `sign` and monthly limit "documents sent per month" in the Platform console, with the usual 80 percent warning and 100 percent refusal. Storage is covered by the existing storage meter. | P1 |
| F-63 | Audit log entries in Halo's own audit log for administrative actions (template changed, certificate changed, settings changed, document voided). | P1 |
| F-64 | The module appears in the workspace export (files and records) and in teardown. | P1 |
| F-65 | User Guide pages and four-language strings (en, ko, ms, zh). | P1 |

# 4. Out of scope for now

In-person (hand-over device) signing, Word and Excel input, SMS delivery, face or ID-card
verification (eKYC), conditional fields, payment fields, per-tenant custom domains for the signing
page, embedding the editor in other sites, and signatures by licensed certificate authority per
signer (the P3 certificate is for sealing, not per person).

# 5. Merchant registration: the target end-to-end flow

1. A merchant fills the **registration form** (P3) or an agent creates the contact (P1). The
   contact receives the tag "Merchant applicant" and the business details in custom fields.
2. The automation "Merchant onboarding" (P2) starts: it sends **Merchant Agreement** to the
   merchant by WhatsApp and email. Fields the merchant must complete: signature, company registration
   number, authorised person's IC number, bank account, upload of the business registration
   certificate and an ID copy.
3. The merchant opens the link on their phone, enters the code, reads, fills, signs.
4. The countersigner (Vircle Director) is notified in Halo and signs (P2).
5. The sealed PDF and certificate are saved to the contact. The contact's stage becomes "Merchant
   signed". A ticket "Merchant KYC review" is opened for the Merchant Operations team with the
   documents attached.
6. A webhook tells the merchant backend that the merchant is ready for activation. The merchant is
   sent a welcome message with their signed copy.

Until P2, steps 2, 4 and 6 are manual: an agent sends from the contact page, countersigns, and
reads the completion email.

# 6. Rules the module must obey

- **Tenant isolation.** Every table carries the workspace id and is protected by row-level
  security. Signers reach their document only through their private link and never see another
  document.
- **Immutability.** A sealed file and its audit trail cannot be changed by anyone, including
  administrators. Corrections are made by voiding and sending a new document.
- **Consent and privacy.** Signers consent to electronic signing, and the page states what is
  collected (name, email, phone, network address, device). Personal data in documents is covered by
  the workspace's own privacy obligations; legal review of the Personal Data Protection Act position
  is part of Phase 0.
- **Retention versus deletion.** Halo deletes a workspace's data after a 30-day owner request.
  Signed contracts may need to outlive that. Proposal: the owner's **export** always includes signed
  files; a **retained copy** of sealed documents and certificates is kept by the platform for the
  retention period, held without the workspace's other data. Needs your decision and legal advice.
- **No branding of the supplier on customer pages.** Signer pages and emails use the workspace's
  name and logo, and neutral wording for Halo.

# 7. Permissions

| Permission | Allows | Default roles |
|---|---|---|
| `sign.view` | See documents and templates | Agent, Admin, Owner |
| `sign.send` | Create and send documents, remind, resend | Agent, Admin, Owner |
| `sign.void` | Void a document, change a recipient | Admin, Owner |
| `sign.templates` | Create, edit and archive templates | Admin, Owner |
| `sign.settings` | Settings, certificate, retention, forms | Admin, Owner |
| `sign.sign` | Countersign inside Halo | Admin, Owner |
| Menu item `menu.sign` | Shows Sign in the sidebar | Everyone with the module on (read only) |

Halo's four roles are Viewer, Agent, Admin and Owner. The read-only stakeholder preset has the menu hidden by default, as with other modules, and an administrator can change any of these defaults per role in Roles.

# 8. Limits proposed (all adjustable)

| Item | Default |
|---|---|
| Template or document file | 25 MB, 50 pages |
| Signers per document | 6 |
| Fields per document | 300 |
| Signer upload per file | 10 MB, PDF, JPG, PNG |
| Link and code | link valid until the document expires; code 10 minutes, 5 tries |
| Default expiry | 14 days (workspace setting, 1 to 90) |
| Reminders | day 3 and day 7 |
| Manual remind | once per 24 hours per signer |
| Documents sent per month | set by the operator per workspace |

# 9. Acceptance, per phase

**Phase 1 is accepted when** a real agreement can be sent from a contact page, signed on an Android
phone and an iPhone by a person with no account, and the sealed PDF opens in a standard PDF reader
with a valid signature (accepting that the certificate is not CA-trusted yet), shows the
certificate page, appears on the contact, and cannot be altered or deleted. The audit trail is
complete and chained, an unrelated workspace cannot see any of it, the signer page passes keyboard
and screen-reader checks, and strings exist in four languages.

**Phase 2 is accepted when** the merchant onboarding automation runs from a contact tag to a
completed, filed, notified document with no manual step, reminders and expiry run on time, the
public API creates and reads documents with a key, and webhooks arrive signed.

**Phase 3 is accepted when** the public form creates contacts and starts the flow, sealed files show
as trusted in common readers, the verify page confirms an untouched file and rejects a changed one,
retention blocks early removal, and a load test of 200 documents in an hour completes within the
agreed time.

# 10. Questions for you

1. Confirm or change the six assumptions in section 1.
2. Which documents will you send first (name them and say how many pages and signers), so the first
   template is built from the real thing?
3. Which fields must a merchant fill, and which of them are sensitive (IC, bank account)?
4. Who is the countersigner, and must they sign before or after the merchant?
5. Is WhatsApp the main channel? If so, are you able to get a WhatsApp utility template approved
   for the invitation message?
6. Retention period and the deletion exception (section 6).
