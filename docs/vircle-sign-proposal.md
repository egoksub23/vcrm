# Document signing in Halo: options and recommendation

Written 6 Oct 2026, from a read of the OpenSign fork (`egoksub23/VircleSign`, OpenSign 2.37.0, last
upstream commit 21 Aug 2026) and of how Halo modules are added. Effort figures are planning figures
for one engineer, not commitments. Licensing statements are a plain reading of the text, not legal
advice.

## 1. What is wanted

Generate a form or contract from a template, attach documents, send it for electronic signature,
store the signed result, and manage documents afterwards. First use: **automating merchant
registration**. It should live inside Halo, not beside it.

## 2. What the OpenSign fork really is

| Area | Finding |
|---|---|
| Stack | React 19 + Vite client, Node 22 + Express 5 + **Parse Server 8** server, **MongoDB**, **LibreOffice** in the server image for DOCX. Four containers. Nothing in common with Halo's Next.js + Postgres. |
| Public API | **Not in the repo.** No `/api/v1`, no API tokens, no webhooks, no reminder job. The menu items "API Token" and "Webhook" are stubs. Integration would be raw Parse cloud functions with the master key. |
| Tenancy | Tenant, organisation, team, user, but isolation is by per-document ACL. Documents carry no tenant id, many functions run with the master key and no tenant check, and anyone can `get` a document by id. |
| Signing engine | Stamping is done **in the browser** (pdf-lib) and the server signs whatever PDF the client uploads. The server then applies a PKCS7 signature (`@signpdf`) and builds a completion certificate with a SHA-256. Ships a self-signed dev certificate. About 700 lines of real engine. |
| Features present | Draw/type/upload signatures, text/date/checkbox/dropdown/radio/image fields, sequential signing, optional email OTP, decline, bulk send, templates, email builder, 7 languages. |
| Missing | Webhooks, working reminders, server-side expiry, SMS/WhatsApp, in-person signing, per-tenant sending domain, SSO into it. |
| Branding | "OpenSign" name, logo, and a complaints link to opensignlabs.com are in source, not config. |
| Security hygiene | Default master key and certificate password committed, master key allowed from any IP, open CORS, 4-digit plain OTP with no rate limit, unauthenticated `/decryptpdf`, almost no tests. |
| Licence | **AGPL-3.0**, except `apps/OpenSignServer/cloud/customRoute`, which points to a licence that is not in the repo. |

### Licence consequences (confirm with a lawyer)

- Running stock OpenSign as a **separate, unmodified** service and calling it over HTTP puts no
  obligation on Halo.
- **Modifying** it (branding, missing API, SSO) and letting users interact with it over a network
  requires offering the modified source to those users.
- **Copying or porting** its code into Halo makes that part of Halo a derivative work under AGPL.
- **Rebuilding the same capability from scratch** with the underlying libraries (pdf-lib,
  `@signpdf/signpdf`, node-forge, pdf.js) carries no AGPL obligation; those libraries have their own
  licences, which are permissive.

## 3. What a Halo module must touch (so any option is priced fairly)

A native module touches about 13 places: a migration (tables with `account_id`, RLS, capability
seeds, flag and quota changes, export/deletion handling), CI grants and guard-catalog entries,
capabilities and the sidebar and page guard, platform feature flag and limits, four test files that
enforce parity, API routes (`requireCapability`) and `/api/v1` scopes, encrypted secrets, a webhook
receiver, an automation trigger and a step, email/WhatsApp delivery, storage and archive rules,
teardown, four-language strings and the user guide, and deployment. Halo already supplies most of
the hard parts: tenancy and RLS, roles, audit log, usage metering, workspace export and deletion,
private signed-URL storage, email with per-workspace sender, the automation engine, outbound
webhooks and a public API.

An OpenSign sidecar would **not** inherit any of that: its data sits in MongoDB outside RLS,
export, deletion, usage metering and the audit log, so each would be rebuilt as glue.

## 4. Options

### A. Run OpenSign beside Halo (sign.vircle.tech) and integrate

- Fastest to a working editor and signing page (about 2 to 3 weeks to a first merchant document).
- Then you own: the missing API and webhooks, tenant hardening, branding patches, an SSO launch
  token, reminder and expiry jobs, a certificate, Mongo backups, and a sync between Halo contacts
  and OpenSign signers. Halo's SSRF guard blocks private addresses, so Halo must call the public
  `https://sign…` address.
- Two user systems, two data stores, two upgrade paths. Heavy footprint (Parse + Mongo +
  LibreOffice); the VPS size is not documented anywhere.
- Fork upgrade friction is high and the code has almost no tests.
- Licence: stays clean only if unmodified; the fixes above are modifications.

### B. Build natively in Halo, using OpenSign as a reference (recommended)

- One stack, one database, one login, one audit trail, one export and deletion path.
- Tenancy by RLS from day one, so it can be offered to customers later with no rework.
- Reuses automation (trigger "document signed", step "send for signature"), webhooks, contacts,
  tickets, notifications, email and WhatsApp.
- No AGPL obligation if it is written fresh (do not copy OpenSign source; read it for behaviour).
- Cost: the field-placement editor and the signing page are real work. Planning figure 5 to 6 weeks
  for a usable first version, 3 more for the second.

### C. Hybrid: OpenSign for a Vircle-only pilot, then replace

Gets merchants signing sooner, but the pilot's glue (API shim, polling, branding) is thrown away
when the native module arrives, and any modification triggers the AGPL offer. Choose this only if
there is a hard date for the first merchant batch that B cannot meet.

## 5. Recommendation

**Build it natively (B), behind a Vircle-only operator flag first** (`sign`, off for new workspaces,
on for Vircle), the same way Jira and Incident Reporting were handled. That keeps the first release
within the existing scope decision (communication stack and tickets for customers), and the
multi-tenant design means turning it on for customers later is a switch, not a rebuild.

Why: the OpenSign engine is small and the libraries it uses are available to us directly; everything
around the engine (tenancy, API, webhooks, retention, audit, export) is what OpenSign lacks and Halo
already has.

## 6. Proposed design (native)

**Tables** (all `account_id`, RLS, cascade on workspace delete): `sign_templates` (source PDF,
fields as JSON with page, box, type, signer role, merge key), `sign_documents` (status, contact /
ticket / deal links, expiry, sequential flag, final file path and SHA-256), `sign_signers` (hashed
token, channel, order, OTP attempts, viewed / signed times, IP, user agent), `sign_events`
(**append-only** audit trail, each row hashing the previous one).

**Files:** a new private bucket for originals and signed PDFs, written by the service role only, with
no update or delete for signed-in users. Hash recorded at signing and checked on download. The 16 MB
`chat-media` limit does not apply to it.

**Signing page:** public route `/sign/[token]` outside the dashboard, token stored only as a hash,
`Cache-Control: no-store`, rate-limited, optional OTP by email or WhatsApp (6 digits, expiring,
attempt-limited), mobile first. Fields are filled in the browser; the **server re-validates and
stamps** the PDF, then applies a PKCS7 signature and appends a completion certificate page. Expiry
and order are enforced server-side.

**Certificate:** start with a Vircle organisational certificate held as an encrypted per-deployment
secret; move to a CA-issued certificate so PDF readers show it as trusted.

**Halo integration:** capability `sign.*` (view, send, manage templates, void), flag `sign`, quota
`documents_per_month`, automation trigger and step, outbound events (`sign.completed`,
`sign.declined`, `sign.expired`), `/api/v1` scopes, a Documents tab on the contact, in-app
notification, signing invitations through the existing email identity and a WhatsApp template, a
reminder and expiry cron.

**Merchant registration flow:** a public registration form (or the existing widget enquiry) creates a
contact, the automation fills a template from the contact's fields, sends it for signature, and on
completion attaches the PDF, moves the contact's stage, opens a task or ticket and posts a webhook
to the merchant backend.

## 7. Phases

| Phase | Scope | Planning figure |
|---|---|---|
| 0 | Decisions below, certificate, legal read of requirements | 3 to 4 days |
| 1 | Tables, storage, template editor (PDF upload, field placement, merge keys), send, signing page, server stamping and signature, completion certificate, documents list, contact tab, capability and flag, four-language strings | 5 to 6 weeks |
| 2 | Automation trigger and step, webhooks, `/api/v1`, reminders and expiry, sequential signers, decline and void, bulk send, quota | 3 weeks |
| 3 | Public registration form builder, CA-issued certificate, verification page, retention rules, hardening and load test | 2 to 3 weeks |

## 8. Risks

- **Legal weight.** A simple electronic signature with an audit trail may be enough for many
  agreements, but some documents need a licensed certificate authority or are excluded by law.
  Malaysian requirements for merchant contracts must be confirmed by counsel before launch.
- **Retention versus erasure.** Halo deletes everything when a workspace is deleted. Signed contracts
  may need to be kept; that would be a deliberate exception.
- **PDF handling cost.** Stamping large PDFs is CPU heavy; run it in a bounded queue.
- **DOCX input.** OpenSign uses LibreOffice. Native Halo should accept PDF, and generate PDFs from
  its own templates, rather than carry LibreOffice.
- **CSP.** Halo's CSP is report-only today. Signing is a public page, not an iframe, so no change is
  needed unless the editor is later embedded elsewhere.

## 9. Decisions needed from the owner

1. Vircle-only first, or offered to customer workspaces from the start?
2. Is there a hard date for the first merchant batch (decides B versus C)?
3. Who counsels on Malaysian e-signature requirements, and is a CA-issued certificate required
   at launch?
4. Must signed documents be retained after a workspace is deleted, and for how long?
5. Languages for signers (BM, EN, others) and the channels for invitations (email, WhatsApp).
6. Should the VircleSign fork be kept as a reference only, or archived?
