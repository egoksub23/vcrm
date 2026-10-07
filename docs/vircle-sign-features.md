---
title: "Vircle Secure Sign: feature set"
subtitle: "Document 1 of 3 for review. Requirements, scope and acceptance, revised 6 Oct 2026 (third revision)"
---

# 1. Purpose and how to review this document

Vircle Secure Sign is a native document-signing module inside Halo. It works on **any document**: upload
a PDF, a Word file or an image, place signing locations, text, date and number fields on it, name
the people who must sign (in a set order if you wish), send it for electronic signature, store the
signed result safely, and manage documents afterwards. Documents are organised into **categories**,
and ready-made packs for a business process come as **add-ons**. The first add-on is **Merchant
Registration**: a merchant applies, receives the merchant agreement prefilled with their details,
signs on their phone, and the signed file lands on their record in Halo with no manual handling. A
workspace without an add-on still has the whole core product.

*First revision: the merchant agreement is an add-on template and category, Word files and
any-document editing are needed, and signers are listed with full name, email and an optional
signing order (sections 3.1, 3.2, 3.9, 3.10, 3.11).*

*Second revision, after the sample Merchant Application Form and your online e-invoice form: the
commercial terms differ by merchant group (handled as separate templates, section 3.13), the e-invoice tax
details are added to the application, and the merchant fills the application **in parts, over
several sittings, from one link** (forms, section 3.12). Appendix A maps every field.*

*Third revision, after your answers: signing order is an optional checkbox per document, the code
and WhatsApp are used only when chosen, Word files are converted to PDF and the PDF is what is
worked on, the starting categories are Merchant, NDA, Partnership and Sales, and merchant groups are
simply separate templates you select (the template families and variants of the second revision are
removed). Section 10 lists what is confirmed, parked and still open.*

Each requirement has an id (F-01 and so on) so you can reply "change F-14" or "drop F-22". Priority:

- **P1** first release (Phase 1), enough to run real merchant agreements.
- **P2** second release (Phase 2), automation, API and scale.
- **P1b** Phase 1B, straight after the core: forms filled in parts, and the Merchant Registration
  content. The add-on goes live when P1b is done.
- **P3** third release (Phase 3), trusted certificate, verify page, retention, hardening.
- **Later** parked, not planned.

**Assumptions made so work can start (please confirm or change):**

1. First release is **Vircle only**: an operator switch `sign`, off for new workspaces and on for
   Vircle, like Jira and Incident Reporting. The design is multi-tenant from day one, so offering it
   to customers later is switching it on.
2. Signers use **email or WhatsApp** links; no SMS. Email is the default; WhatsApp only when the
   sender chooses it for a signer.
3. Signer languages at launch: **English and Bahasa Melayu**. Halo's Korean and Chinese files are
   also used for the signer page, because the strings already exist in the Halo language setup.
4. Input is **PDF, Word (.docx, .doc) and images (JPG, PNG)**. Word files are converted to PDF by a
   conversion service and the converted PDF is what is edited and signed, as other signing tools do
   (confirmed); the original is kept. Exact page layout of a Word file depends on its fonts; where
   it must be exact, upload a PDF.
5. The signature is an **advanced electronic signature with audit trail** under an organisational
   certificate. A licensed certificate-authority signature is a P3 option, pending legal advice.
6. Signed documents are **kept for a configurable period** (proposed default 7 years), even if the
   workspace is deleted, as an explicit exception. This needs your decision.
7. The product name is **Vircle Secure Sign**; the sidebar says "Secure Sign". Customer-facing pages and
   emails use the workspace's name and "Halo". Because Halo's help pages must not name Vircle, the
   Secure Sign help pages are owner-only while the module is Vircle-only. If it is later sold to
   customers, the brand on customer-facing wording is a decision to take then.

# 2. Who uses it

| Person | What they do | Where |
|---|---|---|
| **Sender** (onboarding or sales agent) | Uploads or picks a document, lists the signers, sends, follows progress, resends, voids | Halo, Secure Sign section and contact page |
| **Template owner** (operations lead) | Builds and versions templates, fixes field positions and merge keys | Halo, Secure Sign > Templates |
| **Signer** (merchant, no account) | Opens a link, reviews, fills fields, signs, downloads a copy | A public page on a phone or computer |
| **Countersigner** (Vircle director) | Signs after the merchant, inside Halo | Halo, "Awaiting my signature" |
| **Reviewer** (compliance, audit) | Reads the audit trail, verifies a document is untampered | Halo and the public verify page |
| **Platform operator** | Switches the module on, sets monthly limits, sees usage | Halo Platform console |

# 3. Feature list

## 3.1 Templates

| Id | Requirement | Pri |
|---|---|---|
| F-01 | Upload a PDF, Word file or image as a template or as a one-off document (up to 25 MB, 50 pages). Reject password-protected, corrupt or unsupported files with a clear message. | P1 |
| F-02 | Field editor: click or drag on a page to place fields; move, resize, copy, align, delete; keyboard nudging; page thumbnails; zoom. | P1 |
| F-03 | Field types: signature, initials, full name, **date signed (automatic)**, **date the signer picks**, text, multi-line text, email, phone, **number (decimals, currency symbol, minimum and maximum)**, checkbox, dropdown, radio group, **static text the sender writes on the document**, and **file upload by signer** (for example business registration certificate, ID copy). | P1 |
| F-04 | **Signer roles** per template or document (for example Merchant, Director). Each field belongs to a role. Up to 6 roles. A role is either a **signer** or a **filler** (completes fields but does not sign). Roles are filled from the signing list (F-66). | P1 |
| F-05 | Field properties: required or optional, label and help text, placeholder, default value, validation (length, email, phone, a regular expression such as an IC number), read-only. | P1 |
| F-06 | **Merge fields**: a field can be filled before sending from a contact or workspace value (name, email, phone, company, country, any custom field, document reference, today's date). Merge keys are chosen from a list, not typed. From P1b every value is a **data field** (F-82) and merge fields are data fields that came from the contact. | P1 |
| F-07 | Template **versions**: editing a template used by sent documents creates a new version. A document always keeps the exact version it was sent with. | P1 |
| F-08 | Template defaults: roles and their order, whether signing follows the order, expiry in days, reminder schedule, email subject and message, which language to open in, and the category. | P1 |
| F-09 | Template library: search, tags, archive and restore, duplicate, preview as a signer, who changed what and when. | P1 |
| F-10 | Template test mode: send yourself a preview document that is clearly marked TEST and does not count toward limits. | P2 |
| F-11 | Conditional fields (show a field only if another is ticked). | Later |

## 3.2 Creating and sending a document

| Id | Requirement | Pri |
|---|---|---|
| F-12 | New document from a template through a short wizard: choose template, add recipients, check prefilled values, review, send. | P1 |
| F-13 | **New document from the contact page**: the contact is chosen already and recipients and merge values are prefilled from the contact. | P1 |
| F-14 | Recipients are entered in the **signing list** (F-66 to F-72): full name, email, role, channel (email, WhatsApp or both) and order. A recipient can be a Halo contact. | P1 |
| F-15 | One-off document: upload any supported file, place fields and send without saving a template (see F-73). | P1 |
| F-16 | Annexes: attach extra files to the document (read-only, listed in the signing page and included in the sealed packet). | P1 |
| F-17 | Send now or save as draft; resend; change a recipient's email or phone and reissue the link (the old link stops working). | P1 |
| F-18 | Document collection: several documents signed in one sitting (for example Agreement + Fee schedule + Data processing terms), one audit trail. | P2 |
| F-19 | Bulk send: choose many contacts or upload a CSV, one document each, with a preview and a per-row result. | P2 |
| F-20 | Schedule a send for later. | Later |

## 3.3 Invitations and reminders

| Id | Requirement | Pri |
|---|---|---|
| F-21 | Invitation by email using the workspace's sender identity (name and reply-to), with the message, a button and the expiry date. | P1 |
| F-22 | Invitation by WhatsApp, only when the sender chooses WhatsApp for that signer, using an approved template message that carries the link. Counts toward the monthly message limit. | P1 |
| F-23 | When signing follows an order, the next step is invited automatically when the previous one finishes (see F-67 to F-69). | P1 |
| F-24 | Automatic reminders on a schedule (for example day 3 and day 7) and an expiry date. Reminders stop when the document is completed, declined, voided or expired. | P2 |
| F-25 | Manual "Remind now" with a rate limit (once per 24 hours per signer). | P1 |
| F-26 | Copies: cc and bcc on completion; sender and chosen Halo users are notified in Halo when a document is viewed, signed, declined or expired. | P1 |

## 3.4 The signing experience (no login)

| Id | Requirement | Pri |
|---|---|---|
| F-27 | A private one-time link per signer; the page works on a phone first, and on tablets and computers. | P1 |
| F-28 | Optional **verification code** (6 digits by email or WhatsApp, 10 minutes, 5 tries) before the document opens. Used only when chosen, per template or per document; off by default. | P1 |
| F-29 | Language picker on the page (English, Bahasa Melayu; Korean and Chinese available). Defaults to the contact's or workspace language. | P1 |
| F-30 | **Consent to electronic signing** shown before the first signature, in the signer's language. The wording, version and time of consent are stored. | P1 |
| F-31 | Guided filling: progress ("3 of 5 required fields done"), a Next button that jumps to the next unfinished field, and clear errors on the field. | P1 |
| F-32 | Adopt a signature by **drawing**, **typing** (several script styles) or **uploading an image**; the same choice can be reused for initials. | P1 |
| F-33 | The signer sees what earlier signers already completed. They can download the **signed copy once the document is completed**, and not before. | P1 |
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

## 3.9 The signing list and order

| Id | Requirement | Pri |
|---|---|---|
| F-66 | **Signing list** on every document: one row per signer with **full name** and **email** (both required), phone (required only when WhatsApp is chosen), role, and an **order number**. Rows can be added, removed and dragged into a new order before sending; picking a Halo contact fills a row in one click. | P1 |
| F-67 | **"This document needs signing order"** checkbox, shown where the signers are listed, as in other signing tools. **Unticked (the default):** everyone is invited at once, anyone can sign first, and no order numbers are shown. **Ticked:** order numbers and drag handles appear; only the first signer is invited; each next signer is invited automatically when the one before has signed; before their turn a signer's link shows "Waiting for {name} to sign first" and no document content. The choice is made for each document; a template or category can only preset the checkbox. | P1 |
| F-68 | Signers who share an order number form one **step** and sign in parallel; the next step starts when every signer in the step has finished. (Considered for later; until then each order number holds one signer.) | P2 |
| F-69 | While order is on: reminders go only to the current step's signers; a decline stops the chain and tells the sender; expiry applies to the whole document; a countersigner inside Halo sees the document under "Awaiting my signature" only when their step begins. | P1 |
| F-70 | After sending: a signer not yet invited can be renamed, re-addressed or moved to a later position; the current or a finished signer can only be replaced with "change recipient" (new link, same position). The order switch itself cannot be flipped after sending: void and send again. | P1 |
| F-71 | The list and the order are recorded in the sealed record: the completion certificate lists signers in signing order with their times, and the audit trail records each invitation as "invited because {name} finished". | P1 |
| F-72 | A template stores its roles and an optional preset for the signing-order checkbox; the wizard prefills them and the sender may change them for this document. A role can be an internal Halo user (countersigner). | P1 |

## 3.10 Any document: upload, Word, prepare

| Id | Requirement | Pri |
|---|---|---|
| F-73 | **Upload and prepare any document.** From Secure Sign, a contact or a ticket, upload a PDF, Word file or image, place fields with the full editor and send, with no template. "Save as template" is one click at any point. | P1 |
| F-74 | **Word files are converted to PDF** before preparing. The editor shows the converted pages with the notice "This is exactly what will be signed"; the original Word file is kept with the document. If conversion fails, the message tells the sender to save as PDF and upload that. | P1 |
| F-75 | Images become one-page PDFs (a photographed form, a scan). | P1 |
| F-76 | Insert signing locations, text, dates, numbers and the other field types in F-03 anywhere on any page of any uploaded document. | P1 |
| F-77 | **Replace file** on a draft keeps field positions where page count and size match and flags fields that no longer fit. | P2 |

## 3.11 Categories and add-ons

| Id | Requirement | Pri |
|---|---|---|
| F-78 | **Categories.** Every template and document has a category (the starting set is **Merchant agreements, NDA, Partnership and Sales**). Workspaces create, rename and archive their own. Lists filter by category. A category carries defaults that override the workspace defaults: expiry, reminders, code required, a preset for the signing-order checkbox, consent wording, retention. The four starting categories exist for every workspace using Secure Sign; Merchant agreements is filled by the Merchant Registration add-on and the others start empty for the workspace's own templates. | P1 |
| F-79 | **Add-ons** are ready-made packs for a business process. Each can contain a category, templates, contact fields, wording and, later, an automation recipe and a registration form. The first add-on is **Merchant Registration**. | P1 |
| F-80 | **Operator control.** Which add-ons a workspace may use is switched in the Platform console. A workspace Owner or Admin installs an available add-on from Settings > Secure Sign > Add-ons. Installing again never overwrites what the workspace has changed. | P1 |
| F-81 | **Add-on updates.** A new version shows as "Update available" with a list of changes; applying it creates new template versions and never alters sent documents. | P2 |

**What the Merchant Registration add-on contains:** the category *Merchant agreements*; the template
*Merchant Application*, built from your sample, with the form and its parts (Appendix A) including
the new **e-invoice and tax details** part; contact fields for every mapped answer; English and
Bahasa Melayu wording. A template with other fees or terms is made by duplicating it (section 3.13).
Phase 2 adds the onboarding automation recipe and the option lists; Phase 3 the public registration
entry.

## 3.12 Forms: fill in parts, over several sittings, with one link

The merchant application is a long form (company, tax, contacts, bank, documents, terms) that people
rarely finish in one go. P1b makes the document a **form first, then a signature**.

| Id | Requirement | Pri |
|---|---|---|
| F-82 | **Data fields.** Every value on a document is a data field with a key, label and help text in each language, type, options, validation, required rule, the part it belongs to and, optionally, the contact field it fills. One data field can be printed in several places on the document (placements) or nowhere. Asking and printing are separate. | P1b |
| F-83 | **Form definition.** A template has an ordered list of **parts**, each holding data fields. Parts are shown to the signer instead of (or before) the page overlay. | P1b |
| F-84 | **Form field types:** text, multi-line, number, email, phone (country prefix), single choice, multiple choice, yes or no, date, address lines, **list of entries** (for example several business activity codes), **file upload** (a document checklist item), **image** (company stamp), and read-only text to acknowledge (the commercial terms). | P1b |
| F-85 | **Conditional fields.** A field or an upload can appear, and be required, only when another answer says so (for example tax percentage and SST registration number only when the tax type is SST; company registration papers differ for a company and a sole proprietor). | P1b |
| F-86 | **Validation** with a message in the signer's language: digits only, length, pattern, email, phone with +60 default, postcode with 5 digits, minimum and maximum, file type and size. | P1b |
| F-87 | **One link, many sittings.** The signer's single link opens the application overview: each part shows Not started, In progress or Done, with an overall percentage. "Continue" goes to the next unfinished part. Parts can be done in any order. | P1b |
| F-88 | **Autosave on the server.** Every change is saved as the signer types, so closing the page loses nothing. The same link resumes on any phone or computer (after the code, if the code is on). "Saved a moment ago" is shown. | P1b |
| F-89 | **Review and sign** is the last part. It stays locked until every required part is done, then shows the document with all answers printed on it, and the signature, company stamp, name, designation and date. | P1b |
| F-90 | **Prefill and no double asking.** Values already known (from the contact, or from an earlier document in the same packet) are prefilled for the signer to confirm. A value asked in one part is never asked again in another part or another document. | P1b |
| F-91 | **Reopen.** A signer can change any part until they sign. After signing, everything is locked. | P1b |
| F-92 | **Sender's progress view:** per part status, last activity, the answers so far (read only), a reminder that names the unfinished parts, and "extend expiry". | P1b |
| F-93 | **Write-back.** Mapped answers update the contact's and company's fields when the application is submitted; each change is logged with the old and new value. | P1b |
| F-94 | **Form builder** for people with `sign.templates`: add and reorder parts, add data fields, set rules and validation, set text in each language, preview as a signer. | P1b |
| F-95 | **Forward.** During signing, a signer may forward their turn, or one part of the form, to another person (name and email). The new person sees only what was handed to them; forwarding the whole turn makes them the signer for that role. Every forward is recorded in the audit trail, and the sender can switch forwarding off for a template or a document. | P2 |
| F-96 | **Option lists** kept in Settings and shared by all forms: Malaysian states, banks, company registration ID types, tax types, e-invoice phases. A searchable **MSIC code** picker. | P2 |
| F-103 | **Assign in advance.** When preparing, the sender assigns each field, and each part of a form, to a role and names who holds each role, so it is known before sending who signs and who fills what. | P1b |
| F-97 | **Form without signature.** The same form and link used on its own (for example e-invoice details for an existing merchant), with the answers written back. | P3 |

## 3.13 Templates for different terms (merchant groups)

| Id | Requirement | Pri |
|---|---|---|
| F-98 | **Different terms are different templates.** A merchant group, or any case with other fees or clauses, is simply another template in the same category. The sender selects the template when starting a signing process. | P1 |
| F-99 | **Duplicate template** copies the file, fields, form and placements into a new draft with a new name, so a variant takes minutes to make. | P1 |
| F-100 | Fees and other commercial wording are ordinary text in the template, or **static text the sender writes** on the document when the template is set up that way (F-03). | P1 |
| F-101 | The sealed record names the template, its version and the terms as printed. | P1 |
| F-102 | Compare two templates side by side, and a shared library of form parts reused across templates (for example the e-invoice part). | Later |

**Until P1b is built**, a merchant can fill the application directly on the document (F-35 save and
resume), and the e-invoice tax details are an extra page on the template. P1b replaces that with the
form experience; nothing sent in the meantime is lost.

# 4. Out of scope for now

In-person (hand-over device) signing, Excel and PowerPoint input (Word is supported), editing the text of the underlying document (change the Word file and upload it again), SMS delivery, face or ID-card
verification (eKYC), conditional fields, payment fields, per-tenant custom domains for the signing
page, embedding the editor in other sites, and signatures by licensed certificate authority per
signer (the P3 certificate is for sealing, not per person).

# 5. Merchant registration: the target end-to-end flow

0. The workspace has the **Merchant Registration add-on** installed (section 3.11).
1. An agent creates the contact (P1), or a merchant enters through a public registration page
   (P3). The contact receives the tag "Merchant applicant".
2. The automation "Merchant onboarding" (P2) starts: it sends the chosen **Merchant Application**
   template (the one for that merchant's terms) to the merchant, by email and, if chosen, WhatsApp,
   with the signers listed and the signing-order checkbox as set on the template. (Before P2 an
   agent does this by hand from the contact page.)
3. The merchant opens the single link on their phone, enters the code and sees the **parts**:
   company and tax information, invoicing and contact details, e-invoice input, bank account,
   documents, commercial terms, then review and sign. They fill some parts now and come back to the
   rest later through the same link; answers are saved as they go. They sign when every part is done.
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
| `menu.sign` | See Secure Sign, its documents, templates and audit trail | Agent, Admin, Owner |
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
| Template or document file | 25 MB, 50 pages; a Word file must convert within 60 seconds |
| Signers per document | 6 (any number of them can share an order step) |
| Fields per document | 300 |
| Signer upload per file | 10 MB, PDF, JPG, PNG |
| Link and code | link valid until the document expires; code 10 minutes, 5 tries |
| Default expiry | 14 days (workspace setting, 1 to 90) |
| Reminders | day 3 and day 7; they name the unfinished parts |
| Manual remind | once per 24 hours per signer |
| Documents sent per month | set by the operator per workspace |
| Parts per form / fields per part | 12 parts / 40 fields |
| Autosave | every change, kept for as long as the document is open |

# 9. Acceptance, per phase

**Phase 1 is accepted when** a real agreement can be sent from a contact page, signed on an Android
phone and an iPhone by a person with no account, and the sealed PDF opens in a standard PDF reader
with a valid signature (accepting that the certificate is not CA-trusted yet), starting from either an uploaded PDF or an uploaded Word file, with signers listed by name and email and, when order is on, invited strictly one step after another. It shows the
certificate page, appears on the contact, and cannot be altered or deleted. The audit trail is
complete and chained, an unrelated workspace cannot see any of it, the signer page passes keyboard
and screen-reader checks, and strings exist in four languages.

**Phase 1B is accepted when** a merchant opens one link, completes two parts on a phone, closes the
page, returns on a computer through the same link and finds their answers, finishes the remaining
parts, and signs; the answers are printed on the agreement, including the e-invoice tax details; a
conditional field (SST) and a conditional upload (company type) appear and disappear correctly; the
sender sees progress per part; answers are written to the contact; and a second template with
different fees, made by duplicating the first, is sent the same way.

**Phase 2 is accepted when** the merchant onboarding automation runs from a contact tag to a
completed, filed, notified document with no manual step, reminders and expiry run on time, the
public API creates and reads documents with a key, and webhooks arrive signed.

**Phase 3 is accepted when** the public form creates contacts and starts the flow, sealed files show
as trusted in common readers, the verify page confirms an untouched file and rejects a changed one,
retention blocks early removal, and a load test of 200 documents in an hour completes within the
agreed time.

# 10. Decisions

**Confirmed by you (6 Oct 2026)**

| Topic | Decision |
|---|---|
| Merchant agreement | It is a template. Your sample Merchant Application Form is the starting point, with the e-invoice tax details added. |
| Signing order | Chosen for each document with a checkbox "This document needs signing order", as in other signing tools. Off unless ticked. No fixed order is assumed for the merchant or the director. |
| Signers sharing a step | Can be considered later (Phase 2). |
| Countersigner | Same rule: signing order is the sender's choice for each document. |
| Verification code | Used only when chosen for a template or document. |
| WhatsApp | Used only when the sender chooses it for a signer. Email is the default. |
| Word files | Converted to PDF; the PDF version is what is edited and signed. |
| Starting categories | Merchant agreements, NDA, Partnership, Sales. |
| Merchant groups | No special mechanism. Different terms are different templates, selected when starting a signing process. |
| Who fills and who signs | The sender can say in advance which fields and parts are filled or signed by whom (roles), and a signer can forward their turn or a part to someone else (the sender may switch forwarding off). |
| Signer's download | Only after the document is completed. |
| Signing page look | Workspace logo and name (my suggestion, accepted). |
| Name in the sidebar | "Secure Sign". |

**Parked or not needed now:** order of the application parts (as drawn in the UX document); asking the legal name once and a trading name only if different (both fields as on your sample); anything else missing from the screens (none for now).

**Still open, because they affect the start:**

1. Retention period for signed contracts, and whether they may outlive a deleted workspace.
2. Ordering the sealing certificate, and whether a certificate-authority one is needed at launch
   (legal read on Malaysian e-signature requirements for merchant contracts).
3. VPS memory and CPU, or permission to measure them.
4. Option lists for the form: company registration ID types, e-invoice compliance phases, tax
   types, the bank list. (Needed before the form is built; until then they are free choices.)
5. Is the official company stamp mandatory? (Default: optional upload.)
6. WhatsApp template approval, only if WhatsApp will be used for invitations.

# Appendix A. Merchant Application: data fields

Built from the sample *Vircle Merchant Application Form 2024* (sections A to E and the signature
block) and the online e-invoice form. "MA" = the existing application, "e-Inv" = the online form.
Required (Req) follows the stars on your screenshot and the form; please correct any.
Fields that exist in both are asked once.

**Part 1. Company and tax information**

| Data field | Type | Req | In MA | In e-Inv | Notes |
|---|---|---|---|---|---|
| Company legal name (as per SSM) | multi-line | Yes | Registered name | Yes | Proposal: ask once; print on both lines of the MA |
| Trading name (if different) | text | No | Company name | | Shown only if different |
| Type of business | choice: sole proprietor, partnership, Sdn. Bhd., Bhd., others (+ text) | Yes | Yes | | Drives the document uploads (part 4) |
| BRN type | choice | No | | Yes | Options to supply |
| Business registration no. (BRN) | text, digits only, no hyphens | Yes | Company registration no. | Yes | Length rule to confirm |
| When must you comply with e-invoicing | choice | Yes | | Yes | Phase options to supply |
| Tax identification number (TIN) | text | Yes | | Yes | |
| Tax type (SST or not applicable) | choice | No | | Yes | |
| Tax percentage | number | If SST | | Yes | Shown only when tax type is SST |
| SST registration no. | text | If SST | GST No. (replace?) | Yes | Shown only when tax type is SST |
| Business MSIC code(s), one or more | list of entries | Yes | | Yes | Search picker in P2 |
| Business activity (as per SSM) | multi-line | No | | Yes | |

**Part 2. Address and contacts**

| Data field | Type | Req | In MA | In e-Inv | Notes |
|---|---|---|---|---|---|
| Company address (without city, state, postcode) | multi-line | Yes | Yes | Yes | MA has two lines |
| City | text | Yes | Yes | Yes | |
| Postcode | 5 digits | Yes | Yes | Yes | |
| State | choice (Malaysian states) | Yes | Yes | Yes | |
| Country | choice, default Malaysia | Yes | Yes | | |
| Company contact no. | phone, +60 | Yes | | Yes | |
| Contact person: name, designation, contact no., email | text, text, phone, email | Yes | Yes (section B) | | |
| e-Invoice person in charge: name | text | Yes | | Yes | |
| e-Invoice person in charge: email (finance, for queries) | email | No | | Yes | Marked optional on your screenshot |
| e-Invoice email (where all e-invoices are sent) | email | Yes | | Yes | |

**Part 3. Bank account**

| Data field | Type | Req | In MA | Notes |
|---|---|---|---|---|
| Bank name | choice or text | Yes | Yes | Bank list to confirm |
| Account no. | digits | Yes | Yes | |
| Account holder name | text | Yes | Yes | Should match the legal name; warn if not |
| Bank branch | text | Yes | Yes | |
| Swift code (if any) | text | No | Yes | |
| Finance contact person | text | Yes | Yes | |

**Part 4. Documents to upload** (conditional on type of business)

| Upload | Shown when | Req |
|---|---|---|
| Form 9, Form 49 and bank statement header | Sdn. Bhd. or Bhd. | Yes |
| Form D and bank statement header | Sole proprietor or partnership | Yes |
| Photocopy of director or owner ID | Always | Yes |
| Up to 3 pictures of the business premise | Always | At least 1 (to confirm) |

**Part 5. Commercial terms** (read only, from the chosen template's own wording; the merchant ticks "I have read and accept")

Platform fee for FPX, credit card and debit card; the payment channel note; the nine key terms
(partner, right to decline, information requests, account access, refund and void, termination
notice of 60 days, binding effect of the merchant terms, hardware, settlement twice weekly).
Different fees or terms mean a different template (F-98); the values are ordinary text in the template.

**Part 6. Review and sign**

| Item | Type | Req | Notes |
|---|---|---|---|
| Authorised signature | signature | Yes | |
| Official company stamp | image upload | Yes | To confirm |
| Name | text, prefilled from contact person | Yes | |
| Designation | text | Yes | |
| Date | date signed (automatic) | Yes | |
| FW no. | reference, set by Vircle | Yes | Prefilled, not editable by the merchant |

**New in this form compared with the sample:** the whole e-invoice and tax block (BRN type, e-invoice
compliance phase, TIN, tax type and percentage, SST registration no., MSIC codes, business activity,
e-invoice person in charge and e-invoice email).

