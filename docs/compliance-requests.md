# Compliance requests

Part A, the core. A customer's instruction that Vircle must act on, and be able to prove it acted on, with the reasons: closing an account, withdrawing funds, changing a registered phone number. The agreed spec is `docs/compliance-requests-spec.md`; this document is how it is built, how to switch it on, and what is and is not tested. Migration **183**, verify script `supabase/ci/verify-183-compliance-requests.sql`.

Menu **Compliance** (route `/compliance`, the case at `/compliance/[id]`, settings at **Settings > Compliance**), directly below **KYC review** and above **Secure Sign**. The KYC screen stays at `/kyc`. Product wording is "Compliance requests" and "Secure Sign".

> **Part B** (migration **184**, verify script `supabase/ci/verify-184-compliance-intake.sql`) adds the public parent forms at `/c/<slug>`, the emails to the customer and to staff, "Raise compliance request" in the Inbox and on tickets, the reports and their CSV, and the menu badge. Sections 1 to 13 describe Part A; **sections 14 to 21 describe Part B**, which also changes three things above, marked *(changed in Part B)*: who can read a case (section 2 and 4), the hourly job (section 8), and the sign-off of a rejection (section 3).

## 1. Turn it on

1. **Apply migration 183** to the database (after 182). It is idempotent. It writes an explicit `compliance: false` for every workspace and seeds the three standard request types into each.
2. Deploy the code.
3. The operator console: **Platform**, the workspace, **Edit**, switch **Compliance requests** on, **Save**. `compliance` is a platform feature flag, **off for every workspace**, existing and new (the signup seed writes it). The code also reads an absent key, a missing platform row or an unreadable one as **off** (`DEFAULT_OFF_FEATURES` in `src/lib/platform/features.ts`). Switching it off removes the menu item and every `menu.compliance` / `compliance.*` permission from everyone in that workspace at once, so the page and every route answer 403.
4. Define the roles (section 2).
5. Add the hourly job (section 8).

There is no environment variable. It needs the encryption key ring the app already has (`ENCRYPTION_KEY`, optionally `ENCRYPTION_KEYS` and `ENCRYPTION_KEY_ID`): the bank details are encrypted with it, and without a key a case with bank details cannot be saved (the form says so; nothing is stored in the clear).

## 2. Roles and permissions

Six app-tier permissions in a new group **Compliance requests** in **Settings > Roles & permissions** (labels in English, Malay, Chinese and Korean). **Owner and Admin hold all six; nobody else holds any by default.** They can be granted down to Agent (so to any custom role built on Agent), never to Viewer. No named role is created: the owner defines **Head of Compliance** and **Compliance Officer** (and an **Operations** role) as custom roles in the roles screen, and grants:

| Permission | What it allows | Suggested for |
|---|---|---|
| `menu.compliance` | See the menu item and open the area. It opens **no data route by itself**: each route below also checks its own permission. | everyone in the group |
| `compliance.review` | Open requests, record the identity check, review and recommend, add notes, edit details, link tickets and contacts, assign, upload files, close. | Compliance Officer, Head of Compliance |
| `compliance.approve` | The final sign-off (approve, reject, send back to the officer), pause and resume the clock, override outstanding dues with a reason. | Head of Compliance |
| `compliance.reveal` | Reveal the bank details and other protected answers in full, for two minutes. | Compliance Officer, Head of Compliance |
| `compliance.execute` | Tick the operations checklist and mark executing / complete. | Operations |
| `compliance.manage` | Settings > Compliance: request type definitions. | an administrator |

The Head of Compliance may also act as officer by holding `compliance.review` too. **The person who recorded a case's identity check can never sign that case off**, whatever they hold (section 5).

A person who is not a holder of `menu.compliance` cannot see a case through the browser's database access either: the table policies read it (section 4). *(Changed in Part B: Part A let the person who **raised** a case read its row. Migration 184 removed that. A raiser now gets only the reference, the type and the status of their own cases, from a server route; see section 17.)*

A seventh permission, **`compliance.raise`**, belongs to Part B (section 17): raise a request from an Inbox conversation or a ticket. It is app tier, grantable to Agent, held by Owner and Admin by default, and does **not** need `menu.compliance`.

## 3. Workflow and states

```
received -> identity_check -> officer_review -> awaiting_signoff -> approved -> executing -> completed -> closed
                                                      |                ^
                                                      +-> rejected -> closed
```

| From | To | Needs | Rules |
|---|---|---|---|
| received | identity_check | review | "I will do the identity check": assigns the case to the person if nobody has it |
| received, identity_check | officer_review | review | **Records the identity check**: method (call back, video call, ID document, chat verification, in person, other with words), outcome pass or fail (a note is required for fail), who and when are stamped from the signed-in person. A type with no identity check goes through without. |
| officer_review | identity_check | review | Send back for a new check; a note is required |
| officer_review | awaiting_signoff | review | The recommendation (approve, reject, more information); reject and more-info need notes; "approve" needs a passed identity check when the type uses one |
| awaiting_signoff | approved | approve | **Maker-checker** (section 5); the identity check must have passed; a closure with dues outstanding needs an override reason |
| awaiting_signoff | rejected | approve | Maker-checker; a reason is required. *(Part B: the route and the screen also require a reason category for the reports and the words the customer is told, stored in `signoff`.)* |
| awaiting_signoff | officer_review | approve | The Head sends it back; a note is required |
| approved | executing | execute | Also happens at the first tick of the checklist |
| approved, executing | completed | execute | Every checklist step must be ticked (a type with no checklist may go straight from approved) |
| rejected, completed | closed | review (or approve) | "Customer told"; closing stamps `closed_at` and moves the retention date to seven years from then |
| received, identity_check, officer_review | closed | review (or approve) | Closed **without a decision** (a duplicate, the customer withdrew); a note is required |

`closed` is final. The table is in **one SQL function**, `compliance_transition(request, to_status, actor, note, payload)`: `SECURITY DEFINER`, service role only, row lock, validates the table, checks the capability the move needs **for the named person**, applies the rules above, stamps the dates and appends the event. `src/lib/compliance/transitions.ts` is its twin for the routes and the screens; a test reads the migration and checks the two tables agree.

**No plain `UPDATE` can change a protected column** (status, the identity check, the recommendation, the sign-off, the dues standing, the clocks, the dates, the retention date, the reference, the type, the source, the creator), from any role including the service role and the table owner. A guard trigger refuses it unless one of the compliance functions has switched on a transaction-local flag. Two changes need no function: a link emptied when the contact, conversation, ticket or incident it points at is deleted, and the operator's key re-encryption job rewriting `data_enc`.

Other functions, all service-role only, each checking its capability for the actor, locking the row and writing its event in the same transaction: `compliance_update_request` (edits), `compliance_tick_step`, `compliance_set_standing`, `compliance_clock` (pause / resume), `compliance_clock_alert_sweep`.

**Editing.** The customer's details, the answers and the request date can be edited while the case is received, in identity check or in officer review; once it is with the Head of Compliance they are frozen (so the person signing off signs what they saw). Links and the assignee can change until the case is closed. Changing the request date moves both deadlines by the same amount and is recorded with the old and new value. A bank detail can be corrected by someone who holds `compliance.reveal` as well as review, before sign-off; the event names the field, never the value.

## 4. Data model (migration 183)

All tables carry `account_id`, composite foreign keys and row level security.

| Table | What |
|---|---|
| `compliance_request_types` | Per workspace: key, labels (and Malay / Chinese / Korean), `fields` (JSON), `checklist` (JSON), `target_days`, `hard_stop_days`, `requires_identity_check`, `check_dues`, `allow_pause`, `active`, `is_system`, `position`. Three system types are seeded by `compliance_seed_types()` for existing and new workspaces: `closure` (14 / 30 days, identity check, dues block), `withdrawal` and `phone_change` (no clock, identity check). A system type's key can never change and it can never be deleted. |
| `compliance_requests` | The case. `reference` (`CMP-YYYY-NNNNNN`), `type_key`, `status`, `received_at`, `source` (form, staff, inbox, ticket), `channel`, customer name / email / phone (`+60...`), links (`contact_id`, `conversation_id`, `ticket_id`, `incident_id`, `kyc_validation_ref`), `data` (ordinary answers), `data_enc` (protected answers, encrypted), `identity_check`, `review`, `signoff`, `account_standing`, `outcome_reason`, the clocks, `retention_until`, `created_by`, `assigned_to`, `is_test`. |
| `compliance_request_events` | The timeline. Append-only. Kinds: created, edited, status, identity_check, review, signoff, execute_step, note, link, reveal, view, export, clock_pause, clock_resume, attachment, standing, assigned, clock_alert. Ordered by a `seq` identity column. |
| `compliance_request_checklist` | The operations steps, copied from the type's template when the case is created. Done by, done at, a note. |
| `compliance_request_files` | Metadata of the evidence files (name, type, size, SHA-256, path, who, when). The bytes are in the private bucket. |
| `compliance_request_counters` | The reference counter per workspace per year. |

**Reference.** `CMP-2026-000001`: a counter per workspace **and per year**, one atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, so two cases created together get two numbers. A supplied reference is ignored. It never changes. (Sign's reference uses one counter per workspace; incident and ticket numbers likewise. Compliance's resets each year, as the spec asked.)

**Clocks.** When a case is created the database stamps `target_days`, `hard_stop_days`, `target_due_at` and `hard_stop_at` from the type **as it is then**. Changing a type's clocks later changes new cases only. `received_at` may not be in the future or more than 400 days back.

**Visibility.** Row level security: a case, and through it its events, checklist and file rows, is readable by a member holding `menu.compliance` in that workspace. *(Changed in Part B: Part A also let "the person who raised it" read the row; migration 184 dropped that clause from all four policies, because it exposed the customer's name, email, phone and answers to an agent who was only meant to hand the request over. A raiser's status chip comes from a server route that returns the reference, type and status only; section 17.)* Types are readable by `menu.compliance`. Nobody signed in can write any of these tables (no privilege, no policy), and the signed-out role has no access at all. The browser's column privileges leave out `data_enc` and the file `path`. The routes check the permission as well (section 9), and the operator's flag is applied by the app (the database does not know it).

**Maker-checker, in the database.** `compliance_transition` refuses sign-off when the actor equals `identity_check.verified_by` or `identity_check.recorded_by`. The capability is checked **inside the function against the named person** (`compliance_user_can(account, user, cap)` repeats `has_capability`'s resolution for a given person, including custom roles), not only by the route; the route checks `requireCapability` too, so a workspace with the flag off is refused before the database is reached. Chosen over passing "the service verified it" because a bug or a forgotten check in a route then cannot sign off a case.

## 5. Bank details and other protected answers

A field a type marks `sensitive` (the three bank fields of a closure and a withdrawal) is **never** stored in `data`. The service validates the answers against the type, then `sealSensitive()` encrypts the protected ones with the **key ring** (`src/lib/crypto/keyring.ts`, AES-256-GCM) as `encrypt(JSON.stringify({ r: <case id>, v: { field: text } }))` into `data_enc`. The case id is inside the ciphertext, so a ciphertext copied onto another case is refused when it is opened (the same rule as Secure Sign's sensitive answers). `data_enc` is in `ENCRYPTED_COLUMNS` (`src/lib/crypto/reencrypt.ts`), so the operator's re-encryption job rewrites it after a key rotation (a test rotates a key and opens the result).

The detail answer carries each protected field as a **mask** (`•••• 9012`: the last four characters when there are more than eight, otherwise four dots; the same function as Secure Sign) and whether there is an answer. **Reveal** (`POST /api/compliance/requests/[id]/reveal`, `compliance.reveal`): the `reveal` event is written **first** (field names only, never a value); if it cannot be written nothing is returned; ten reveals a minute per person (database-counted, shared across servers); a refused attempt is also an event. The screen shows the values for two minutes and hides them when the time runs out, the page goes to the background, the person presses Hide or leaves. Every answer is `no-store`.

The workspace export leaves `data_enc` out (the export drops any column whose name ends `_enc`, as it does for other secrets): the ciphertext is useless without the key and the plain values must not be in an export.

## 6. Evidence files

The private bucket **`compliance-files`** (not public, 10 MB limit, PDF / JPEG / PNG), paths `account-<workspace>/<case>/<file>-<name>`. Only the server (service role) reads or writes it; the browser gets bytes only from `GET /api/compliance/requests/[id]/files/[fileId]`, which writes a `view` event first, then answers an **attachment** with `no-store`, `nosniff`, `Cross-Origin-Resource-Policy: same-origin` and a sandboxing `Content-Security-Policy`. Uploads use Secure Sign's rules: PDF, JPEG or PNG by their **first bytes** (`src/lib/net/file-kind.ts`, now shared with Secure Sign's form uploads), at most 10 MB a file, 15 files and 50 MB a case, a SHA-256 kept with the row, and the row's trigger writes the `attachment` event. A file cannot be changed or deleted (retention). A failed row write removes the stored object.

**`verify-guard-catalog.sql` needs no change.** Its bucket list (`public_buckets`) is for buckets served **publicly**; this one is private, so it is deliberately not on it. No new function is callable by a signed-in or signed-out user (all `REVOKE`d from `PUBLIC, anon, authenticated`; `EXECUTE` to `service_role` only; trigger functions pin their `search_path`), so `authenticated_ok` and `anon_ok` are unchanged too. The migration test pins both facts.

## 7. Clocks and the pause

`src/lib/compliance/clock.ts` is the one definition (pure, tested):

| State | When | Shown |
|---|---|---|
| on track | before the target | green chip, "Day 9 of 14 target · 21 days to stop" |
| past target | the target date has passed (and the stop is more than 10 days away) | **amber** chip "Past target" |
| near stop | 10 days or fewer before the hard stop | **red** chip "Near hard stop" |
| breached | the hard stop is reached | **red** chip "Breached", "N days past the stop" |
| paused | the clock is paused | grey "Paused", frozen at the pause |
| finished | completed or closed | grey, how long it took |
| none | the type has neither a target nor a stop | no chip, "Day N" |

Day 1 is the request day; "days to stop" is rounded up. A rejected case still waiting to be closed keeps its clock running. Every state is a **word plus an icon**, never colour alone.

**Pause** (`compliance.approve`, a note, only a type with `allow_pause`, which is **off** for every type by default, on a case with a clock that is not finished): logged as `clock_pause`; on resume both stored deadlines move later by the time paused (so they always hold the effective deadline), the time is added to `paused_total_seconds`, and `clock_resume` is logged. While paused, nothing alerts.

## 8. The hourly clock alert job

`GET /api/compliance/clock-cron`, the same `x-cron-secret` as the other jobs, registered as `compliance-clock` with an hourly heartbeat (`CRON_INTERVALS` in `src/lib/cron/guard.ts`; the operator console flags it late after three hours). Add to the crontab:

```cron
0 * * * *   curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/compliance/clock-cron
```

It calls `compliance_clock_alert_sweep()`. For every open, unpaused case with a hard stop, in a workspace whose `compliance` flag is **on**, that is within 10 days, within 5 days or at the stop and has not been alerted for that level, it **claims the case** (`clock_alert_level` rises 1, 2, 3 under a row lock with `SKIP LOCKED`, so two overlapping runs cannot both alert and a case never alerts twice for a level), writes a `clock_alert` event and puts an **in-app notification** (`notifications.type = 'compliance_clock'`, with `compliance_request_id`; clicking it opens the case) in front of every holder of `compliance.approve` or `compliance.review`. *(Part B: the same hourly run then emails the same people for each alert, once; section 16. The sweep itself still sends nothing.)* If the job was down and a case jumped from 12 days to 4 days to go, it alerts once, for the 5-day level.

Without the job: clocks still show live on every screen and chip; there are just no alerts or notifications.

## 9. Routes and the permission each needs

Every route is `complianceStaff(...)` (`src/lib/compliance/http.ts`): `requireCapability('menu.compliance')` first (the operator's flag removes it, so a workspace with the flag off gets 403 everywhere), then the route's own permission, then a per-person rate limit, then the service-role client scoped to the caller's workspace. Answers are `{ error, code, issues? }` with `Cache-Control: no-store`; nothing the database, the network or the key ring said is passed on (a test maps every `compliance_*` code the migration can raise to a code the screens word in four languages).

| Route | Needs (besides `menu.compliance`) |
|---|---|
| `GET /api/compliance/requests` (filters: type, status, due state, assignee, mine, search, dates, paging; counts per bucket) | any of review, approve, execute, reveal |
| `POST /api/compliance/requests` (staff-raised case) | review or approve |
| `GET /api/compliance/requests/[id]` (masked; writes a `view` event) | any of review, approve, execute, reveal |
| `PATCH /api/compliance/requests/[id]` (details, answers, request date, links, assignee) | review or approve (a bank detail also reveal) |
| `POST .../[id]/transition` | the move's own: review (or approve) / approve / execute |
| `POST .../[id]/steps/[step]` (tick) | execute |
| `POST .../[id]/standing` (dues yes / no) | review or approve |
| `POST .../[id]/clock` (pause / resume) | approve |
| `POST .../[id]/notes` | review or approve |
| `POST .../[id]/reveal` | reveal (10 a minute) |
| `POST .../[id]/files`, `GET .../[id]/files/[fileId]` | review or approve (download also reveal) |
| `GET /api/compliance/links?kind=&q=` (find a contact, ticket or incident to link) | review or approve |
| `GET, POST /api/compliance/types`, `PATCH /api/compliance/types/[key]` | read: any work permission or manage; write: manage |
| `GET /api/compliance/clock-cron` | the cron secret |

## 10. The screens

- **List** (`/compliance`): header counts (needs identity check, in review, awaiting sign-off, executing, past target, near hard stop, breached; each is a filter chip), the filter bar (search by reference, name, email or phone; type; status; clock state; assignee; mine; dates), a table on a wide screen and cards on a phone, with the clock chip and line, **New request**, empty states.
- **Case** (`/compliance/[id]`): header (reference, type, status, clock, assignee, retention), a sticky six-step bar (Received, Identity check, Officer review, Sign-off, Execution, Closed), panels: Customer, Request details, Bank and protected details (masked, Reveal), Account standing (closures: yes / no dues; an override reason is needed to approve while dues are outstanding; the shape is ready for the Vircle back-office API, `source: "api"`), Identity check, Officer review, Head of Compliance sign-off (Approve / Reject / Send back, **disabled with the reason in words** when the viewer did the identity check, lacks the permission, the identity check did not pass or dues are outstanding), the pause control, Operations checklist (ticks with who and when), Documents, Links (open buttons; find a ticket, incident or contact; KYC reference), Timeline (newest first, with notes; a person's repeated opens inside ten minutes are shown as one line, the events themselves are all kept).
- **Settings > Compliance** (`compliance.manage`): the types with names in four languages, the clocks, the identity check / dues / pause switches, active, the checklist (add, reorder, translations), and **custom types** with a basic field editor. **The fields of the three standard types are shown read-only** (the staff form and Part B's public form are built on them); a custom type's fields are editable.
- Everything is read-only, with the reason in words, for a person without the permission.

Linking a **conversation** to a case is for Part B (the Inbox button carries it across); Part A's screen shows and removes one if it exists. The API accepts `conversationId`.

## 11. What Part B plugs into *(built: sections 14 to 21)*

- **`createComplianceRequest(admin, input)`** in `src/lib/compliance/service/write.ts` is the one function that makes a case, with `source` (`form`, `staff`, `inbox`, `ticket`) and `channel`, the customer, the answers (validated against the type's fields; protected ones encrypted), `receivedAt`, `createdBy` (null for the form), `assignedTo`, the links, `isTest`. It returns `{ id, reference }`. The database adds the reference, clocks, checklist, created event and retention date, and refuses a link from another workspace.
- **Field definitions** (`FieldDef`: text, multiline, phone, email, number, date, choice, yesno, acknowledge, file; `required`, `sensitive`, labels in four languages) are exactly what the public form should render; `checkAnswers()` in `src/lib/compliance/fields.ts` is pure and shared. The closure form's "refuse incomplete forms" rule is `required: true` on the three acknowledge fields.
- **Events**: Part B's emails add kinds (a later migration widens the `kind` check) and write them with `logEvent()`; `clock_alert` events already exist for the "Head of Compliance" email.
- **`notifications.type = 'compliance_clock'`** is where an email sender would hook the same alert.
- **Reports and CSV**: `GET /api/compliance/requests` already returns the filters and counts; an `export` event kind exists for the CSV audit trail.
- **Account standing** has `source: 'manual' | 'api'`; `compliance_set_standing` is the place the Vircle back-office API would call (with `api`).

## 12. Retention and data protection

- **Seven years**: `retention_until` = the request date + 7 years while a case is open (never earlier than its creation + 7 years); closing sets it to the closing time + 7 years; it only ever moves later.
- **Never deleted by Halo.** A trigger refuses `DELETE` of a case, and of its events, checklist items and files, while `retention_until` is in the future, for every role (the service role and the table owner included), and refuses `TRUNCATE`. Events and file rows can never be updated. The one exception is the one the audit log and the KYC access log have: a workspace being purged by `delete_workspace_data()` (migration 153), which sets `vircle.purge_account` to its own id (only a database owner role can; the API roles are refused whatever they set). A case past its retention can be deleted by a database owner; no job does it.
- **Workspace export**: the tables are exported like any table with an `account_id`; the `data_enc` column is left out (the export drops every column whose name ends `_enc`), which is the safer choice: exported ciphertext is useless without the key ring and the plain values must not travel in an export. The file rows are exported with their storage path (a path is not a secret); the files themselves are removed with the workspace's storage folder at deletion.
- **No secrets in the trail**: events are built from named arguments; `safeDetail()` keeps only small plain values (ids, field names, statuses, the note a person typed), and tests search every event of every route for the bank details.
- **People**: `created_by`, `assigned_to`, the actors in events and the identity check have no foreign key on the login, so deleting a login never touches a case under retention (the screens say "Former member").
- The identity check and the Head's decision are personal data about the customer and the staff. Under the PDPA decide who may read the timeline (it is the people with the compliance permissions) and tell customers the retention period.

## 13. Tests, and what they do not cover

- `supabase/ci/verify-183-compliance-requests.sql` (run it rolled back against production, with 182 before it if 182 is not applied yet): the permissions, the flag, the seeded types, references per workspace, clocks stamped from the type, the checklist copy, every illegal move, the capability each move needs for the named person, maker-checker with a second person signing, dues override, edits and their freeze, the pause, the sweep (once per threshold, the flag, the recipients), visibility by role and workspace, the column privileges, retention refusals for the service role and the table owner, the purge exception, the export, the functions not callable by the API roles. **It also ran in PGlite** (Postgres in WASM) against a stand-in of the pieces it reads: it passed, with the migration run three times in a row. PGlite is not production: its stand-ins for `has_capability`, the signup flow and the export functions are simplified, and the export and `delete_workspace_data` checks are skipped there (the real functions are absent), so run the script against production inside a rolled-back transaction before relying on it.
- `src/lib/compliance/*.test.ts`: the clock rules (pause included), the transition table (and its agreement with the migration), maker-checker, references and phone numbers, the field definitions and answers, encryption round trip, masks, key rotation, the error mapping, `migration-183.test.ts` (the text of the migration), and `service/service.test.ts` (creation, the list and its counts and filters, the workspace wall, masked detail, reveal, edits, steps, files, settings, the job) against the in-memory database.
- `src/app/api/compliance/compliance-routes.test.ts`: every route: `menu.compliance` first, each route's own permission, `menu.compliance` alone opening nothing, rate limits, `no-store`, codes only, the events, file headers, the cron secret.
- `src/components/compliance/*.test.*`: the pure helpers and the markup of every panel in all four languages (masked and revealed, the step bar, the sign-off with each disabled reason, the checklist, files, links, timeline, settings, the New request form).
- Capability catalogue, parity, SQL, nav, page-access, route-surface and platform-flag tests.

**Not covered by a test** (there is no DOM renderer in this repo): clicking, typing and focus movement, the two-minute reveal countdown and the page-hidden listener, the file picker, the real network calls, the phone layout and the dark appearance. **Not verified at all**: any real mailbox (none is used), the real storage bucket (the in-memory database stands in; `compliance-files` is created by the migration but no real upload was made), and the running app in a browser.

---

# Part B

## 14. What Part B adds, and the migration

Migration **184** (`supabase/migrations/184_compliance_intake.sql`; idempotent; apply it **before** the code is deployed; it needs 183). Verify script `supabase/ci/verify-184-compliance-intake.sql` (self-contained; run it rolled back against production with the text of 183 and 184 in front when they are not applied yet; it ends in `ROLLBACK-OK: ...`).

| Part | What |
|---|---|
| Capability | `compliance.raise` (app tier, grantable to Agent, Owner and Admin by default; no `menu.compliance` needed). SQL defaults, the TypeScript catalogue, the parity tests and the roles-screen labels in four languages. |
| Raiser | The four case policies lose "or the person who raised it". |
| Public forms | `compliance_public_forms` (per workspace and type: on/off, slug, notice per language, Turnstile, maximum amount, bank list), `compliance_email_codes` (hashes only). Only `closure` and `withdrawal` can have a form. |
| Case | `customer_locale` (en, ms, zh, ko), `email_verified_at`, and a partial unique index `compliance_requests_form_open_email`: one OPEN form request per type per email, case-insensitively (open = received to executing; a rejected, completed or closed case does not count). |
| Notices | `compliance_notices`: one row per email about a case, `UNIQUE (case, kind, key)`. The timeline gets the kind `notice`. |
| Exports | `compliance_exports`: who exported the CSV, the filters and the row count; append-only. |
| Decision | `compliance_transition` is replaced by 183's function plus two stored values on a rejection: `reason_category` and `customer_reason`. Validated when given, never required in SQL (so a request in flight between the migration and the deploy cannot fail; the route and the screen require them). |
| Intake fields | `compliance_intake_fields(account)` adds `declaration` (closure and withdrawal), `reason_kind` and `proof` (withdrawal) to the standard types of every workspace, never overwriting an edit, and the signup seed calls it. |
| Notifications | the type `compliance_signoff`. |

Nothing new is callable by a signed-in or signed-out user (every function `REVOKE`d, `EXECUTE` to `service_role` only, `search_path` pinned) and every new table has row level security on **and no browser privilege and no policy**: the server is the only reader. `verify-guard-catalog.sql` needs no change. `verify-183` was made tolerant: on a database that has 184 the raiser reads nothing.

## 15. The public parent forms (`/c/<slug>`)

Replaces the Airtable "Vircle Account Closure Request" form. Public, no login, `noindex`, `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, its own minimal frame (like `/s` and `/r`), language switch in English, Bahasa Melayu, Chinese and Korean.

### The flow, step by step

1. **Open the address.** `GET /c/<slug>`: the server finds the form by its slug. It must exist, be on, belong to a workspace whose `compliance` flag is **on** (and active), and its type must be active and carry the fields the form fills. Anything else (unknown, off, flag off, no key, type missing a field) is the same plain **"This form is not available"** page, never saying which. The page is drawn with a **signed form token** (the Secure Sign registration token, bound to the form's id), the workspace's name and logo, the extra notice, the bank list, the maximum amount and the 14-day target.
2. **Ask for a code.** `POST /api/compliance/public/<slug>/code {email}`. Limits (shared across servers, the address and the caller kept only as keyed hashes): 90 a minute per process per caller; 60 an hour per caller and 800 an hour per form for everything; 8 codes an hour per caller; **3 codes an hour per email**; 300 codes an hour per form. A filled hidden field is answered like a success and sends nothing. If the form has Turnstile and the operator set the keys, the token is verified **here** (where the email cost is). A new code makes the previous one for that address useless. The code goes by the workspace's sender (mailbox first, then Resend), in the language chosen. Stored: a keyed hash of the code that also names the form and the (hashed) address, an expiry of **15 minutes**, and the attempt counter. If the email cannot be sent the code is taken back and the page says so.
3. **Enter the code.** `POST .../verify {email, code}`. Each try is counted in the database **before** it is judged (an atomic update that only succeeds while tries are left), **5 tries** per code. A code is used once. The answer for a code that was never asked for, one for another address and one already used is the same (`no_code`). Success sets an **HttpOnly, SameSite=Lax** cookie `cmp-s-<slug>` for **60 minutes** whose value is `<form id>.<hash of the address>.<issued>.<expires>.<signature>` (HMAC under a key derived from the encryption key ring). It carries a hash of the address, not the address.
4. **The form.** The address is shown masked (`s•••@example.test`). **Closure**: name; registered phone (`+60...`, validated and normalised: `012-334 4556` becomes `+60123344556`; the hint is "Format +6012334455667"); "Do you want to close your E-Wallet account?" Yes / No (**No creates nothing** and shows "No request was made"); the warning that closing closes both the Parent (Principal) and every Child (Supplementary) account for good and that a Child-only closure goes through Customer Support; two **required** ticks (every child has finished school; every allowance is stopped and cancelled in the app); an optional reason; the bank (a list, or *Other bank* with its name), account number, account holder name; the declaration. **Withdrawal**: name; phone; amount in RM (positive, at most two decimals, up to the form's maximum); why (over top-up / another reason with words); transaction references; an optional proof; the bank details; the declaration. The text says "We aim to complete closure within 14 days of your request" (the number comes from the closure type's target); **the 30-day regulatory stop is never shown to customers.**
5. **The letter.** The bank account holder name is compared with the account holder name after normalising case, spaces, punctuation, accents, leading titles (Encik, Puan, Dato', Dr, Tan Sri ...), the connectors *bin / binti / bt / a/l ...*, the spellings of Muhammad and the order of the words (`names.ts`). If they differ an **authorization letter** (PDF, JPEG or PNG, 10 MB) is **required**, server-side too. A name that merely contains the other, or has an extra word, is different: the letter is asked for.
6. **Submit.** `POST .../submit` (multipart: `payload` JSON, `letter`, `proof`). Guards, in order: the cheap ceiling per caller; per-caller and per-form limits; **the hidden field** (answered `ok` with no reference, nothing done); **the page token** (genuine, for this form, 3 seconds to 2 hours old; otherwise a fresh token comes back to retry with); **the session** (the cookie must be current, for this form, and carry the hash of the **same address typed again**: otherwise `session_invalid`, confirm the address again); not less than **8 seconds** after the code was entered; **strict validation** (a closure without both ticks or the declaration is refused with a code for each field); **the files** (kind from the first bytes, size, the letter required when names differ); then the per-caller (5 an hour), per-form (60 an hour) and per-email (6 a day, across forms) limits.
7. **One open request per type per verified email.** Looked up across every source; a repeat gets the **same confirmation with the reference of the request the person already has** and creates nothing (the person has just proved they control that address, so this tells nobody else anything). Two posts at once are held apart by the unique index: the loser gets the winner's reference.
8. **The case.** The files go into the private bucket **before** the case exists (a closure that needs a letter never exists without it); then `createComplianceRequest` (source `form`, channel `web_form`, `received_at` now, `created_by` null, `email_verified_at` = when the code was entered, the language, the contact if one matched). The database stamps the reference, the clocks and the checklist. **`identity_check` stays not done.** If the case cannot be made the stored objects are removed.
9. **The contact.** Matched **within the workspace only**: exactly one contact by the verified email (case-insensitive), else exactly one by the normalised phone; none or more than one means `contact_id` stays null (staff can link it). A soft-deleted contact is ignored and another workspace's is invisible. **No contact is ever created.**
10. **The confirmation** page shows the reference (`CMP-YYYY-NNNNNN`), the masked address and a plain "what happens next". The confirmation **email** is sent (once-only claim) and a failure is recorded, never shown as an error.

### Every public route and its guards

| Route | Guards |
|---|---|
| `GET /c/<slug>` | the cheap ceiling (60 a minute per caller); unknown / off / flag off / type incomplete / no key = one "not available"; signed token per visit; noindex, no-store, CSP allowing Turnstile only here |
| `POST /api/compliance/public/<slug>/code` | not-found for any of the above; limits per caller, form and address (3 an hour); hidden field; Turnstile when on; body at most 8 KB; hashes only stored; no answer says whether the address is known |
| `POST .../verify` | not-found as above; every try counted before it is judged, 5 per code; single use; a missing, foreign or used code is one answer; cookie HttpOnly, SameSite=Lax, 60 minutes, a hash not the address |
| `POST .../submit` (also the file upload: the files travel in the same post so a case never exists without the letter it needs) | everything in step 6; body at most about 20 MB read in pieces and stopped at the cap; files by first bytes; nothing stored is answered back; a repeat is not distinguishable |

All are in `route-surface.test.ts` `PUBLIC_ROUTES` with reasons. `next.config.ts` gives `/c/:slug*` the same `private, no-store` and Turnstile-capable CSP as `/r/:slug*` (the CSP is still **report-only** like every route's; see the comment in that file).

### What is stored, and what is shown

Stored: the answers (the three bank answers **encrypted** in `data_enc` with the case id inside the ciphertext, exactly as Part A; everything else in `data`), the customer's name, the verified email, the normalised phone, the language, the letter and proof in the private bucket (row, hash, never public), a `created` event (source `form`) and, when an email goes, a `notice` event. In the **codes table**: keyed hashes only. **Never stored by the public side:** the caller's address (only a keyed hash for limits), the bank details outside the ciphertext, the code.
Shown to the parent: the reference, the address they typed (masked) and their own typing. **Nothing stored is ever displayed back**, no error says whether an email, a phone number or a case exists, and nothing personal is in a URL or a log (the logs say "a public submission failed", nothing more).

## 16. Emails

All through `sendWorkspaceEmail` (the workspace's connected mailbox first, with the `X-Halo-System` mark every mailbox sender adds so it never re-enters the Inbox, then the platform sender). The words are in `src/lib/compliance/messages.ts` in four languages. A customer email never contains bank details, the full phone number, a file or a link to a staff screen, and never the regulatory stop; the only date a customer is told is the practice target.

| Email | To | Trigger |
|---|---|---|
| Verification code | the parent | asking for a code on the public form |
| **Received** | the customer | the public form submission (automatic); a staff-made or raised request when *Email the customer a confirmation* is ticked (on by default with an address) |
| **More information needed** | the customer | a person with review or approve presses *Ask for more information*, writes the text, sees the **preview**, sends. Logged with who sent it. |
| **Approved** | the customer | only when *Tell the customer it is approved* is ticked at sign-off (off by default) |
| **Rejected** | the customer | the Head rejects: the reason **category** and **what the customer is told** (separate from the internal note) are required and **previewed**; the tick is on by default |
| **Completed** | the customer | Operations marks the request complete; the tick is on by default |
| **Waiting for sign-off** | holders of `compliance.approve` (not the person who recorded the identity check) | the case reaches `awaiting_signoff`, once per hand-over; an in-app notification of type `compliance_signoff` goes to the same people |
| **Clock alerts** | holders of `compliance.approve` or `compliance.review` | the hourly job emails the sweep's **5-days-to-the-stop** alert and the **breach** alert (the 10-day alert is the in-app notification only), in the recipient's own language |

**Once only.** Every email is *claimed* first: a row in `compliance_notices` with a unique key per case, kind and key (`once`, a nonce for a written message, the alert's threshold, the hand-over's timestamp). Whoever inserts the claim sends; a retry, a double click or a second server finds it and does nothing. A manual *Send again* may take over only a notice that **failed** (or one claimed more than ten minutes ago by a server that died). The hourly job reuses the sweep's own claim (`clock_alert_level` and the `clock_alert` event) and gives each alert's email its own claim, so a run that died halfway is finished by the next without repeating anyone.
**Results.** Each attempt is a `notice` event (who asked, which notice, `sent` / `failed` / `skipped`, the language, a **named reason** such as `mailbox_reconnect`, `not_set_up`, `address_rejected`, `no_address`), never the address, and never blocks the move. The case's *Emails to the customer* panel lists them with the reason in words and offers *Send again* for a failed one.
**Language.** The form's language choice, else the contact's language, else English. A staff email uses the recipient's own language, then the workspace's.
**Guard.** The text a person writes for a customer is refused if it contains the case's bank account number or phone number (digits are compared, so spaces and dashes do not hide them).

## 17. Raising from the Inbox and from tickets

A person with **`compliance.raise`** sees **Raise compliance request** in an Inbox conversation's header and on a ticket (only while the workspace has Compliance on; the operator's flag removes every `compliance.*` capability, this one included).

- **The dialog** (`GET /api/compliance/raise/context`): the type (closure, withdrawal, phone change), the customer's name, phone and email prefilled from the contact, how it arrived (the conversation's channel), the type's staff fields (no files, none of the public form's helpers), **when the customer asked** (now; *earlier* needs a date, time and a reason that is written on the request), a note, and *Email the customer a confirmation*.
- **The raise** (`POST /api/compliance/raise`): the conversation or ticket is read with the **caller's own session** (row level security decides whether they may open it); the case is made by `createComplianceRequest` (source `inbox` or `ticket`, `created_by` the person, linked to the contact and to the conversation or ticket); a line **"Compliance request CMP-... raised"** is left on the conversation as an internal note (`postInternalComment`) or on the ticket as a comment. It carries the reference and nothing else; in a conversation the reference becomes a link to the Compliance list only for a person who holds `menu.compliance`.
- **Duplicates.** An open request of the same type for the same contact, email address or phone number refuses the raise (`409 duplicate_open`). The reference is named **only** to a person who holds a compliance permission.
- **What the raiser sees** (`GET /api/compliance/raised`): the cases **they** raised, as `{ reference, typeKey, typeLabel, status, raisedAt }` with `status` one of *Received, In review, In progress, Done, Not approved, Closed*, and the case's id only if they also hold a compliance permission. No customer, no answer, no bank detail, no reason, no note. It shows as a chip on the conversation or ticket (`CMP-2026-000014 · In review`) and in a short **My raised requests** list inside the dialog.

## 18. Reports (`/compliance/reports`)

For `compliance.review` or `compliance.approve`. The cases **requested** in a date range (the last 30 / 90 days, this year, all time or your own dates; the same set for every figure), at most 5,000 (the newest; the page says when there were more). All definitions are pure code (`src/lib/compliance/reports.ts`) with worked examples in `reports.test.ts`:

| Figure | Definition |
|---|---|
| By type and status | counts of the cases in the range |
| Open / finished | open until `completed` or `closed` (a rejected case waiting to be closed is still open) |
| Against the target and the stop | for cases with a clock: **completed within the target** (`completed_at <= target_due_at`), **after the target but within the stop**, **after the stop**, and **still open past the stop** (open, not rejected, now past `hard_stop_at`); the shares are of the cases classified. A case still inside its time is neither. The stored deadlines already include any pause. |
| Days to decision / completion | from `received_at` to `decided_at` / `completed_at`, in days with one decimal: average and median, over the cases that have the date |
| Sign-offs by person | approved and rejected by the person who signed |
| Rejections by category | the category the Head chose; older rejections without one are "No category recorded" |
| Open ageing | 0 to 7, 8 to 14, 15 to 30, over 30 days since the request |

**CSV** (`GET /api/compliance/reports/export`, 10 an hour per person): columns `reference, type, source, status, received_at, target_due_at, hard_stop_at, decided_at, completed_at, days_to_complete, outcome` (`open`, `approved`, `rejected`, `completed`, `closed_without_decision`), UTF-8 with a byte order mark, formulas made harmless, **no name, phone, email, bank detail, reason or note**. The export is written to `compliance_exports` (who, the filters, the row count, whether it was cut at 5,000) **before** the file is returned; if it cannot be written nothing is returned. Tables with clear numbers and a thin bar beside a share (the number is always written beside it, so nothing depends on the bar).

## 19. The menu badge

The Compliance item in the sidebar shows a number for people who can act and nothing at zero: for `compliance.approve` the cases awaiting sign-off that they could sign (**not** one whose identity check they recorded); for `compliance.review` the cases in `received`, `identity_check` or `officer_review`; the sum for both. `GET /api/compliance/badge` returns `{ count }` and nothing else; the sidebar asks only when the person holds the menu and one of the two permissions, every 60 seconds, on focus, and straight after a case moves (like the Secure Sign badge).

## 20. For operators: turning it on, and testing it on a staging workspace

1. Apply 183 then **184** (run `verify-184` rolled back first). Deploy the code. Part A's hourly crontab line for `/api/compliance/clock-cron` now also sends the alert emails and clears the old codes (nothing new to schedule).
2. The server needs the encryption key ring it already has (`ENCRYPTION_KEY`, optionally `ENCRYPTION_KEYS`/`ENCRYPTION_KEY_ID`): the public forms hash and sign with keys derived from it and refuse to open without one. It needs a way to send mail (no link is ever put in an email, so no site address is needed): a connected mailbox on the workspace, or the platform sender (`RESEND_API_KEY`). Without any way to send, a parent cannot receive a code and the form tells them it could not send.
3. **Turnstile (optional).** Set **both** `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` (a restart, not a rebuild). The switch in **Settings, Compliance, Public forms** is then available per form; the check is made when a parent asks for a code. With either key missing the switch is disabled and says so.
4. **Staging test** (a workspace made for testing, with the `compliance` flag on): in **Settings, Roles & permissions** give yourself the Compliance permissions and `compliance.raise` through a custom role; in **Settings, Compliance, Public forms** switch on the closure form and copy its address; open it in a private window; enter an email address you control and confirm the code; complete the form once with matching names, once with a different bank holder name (the letter is then required) and once answering *No*; check that a second submission with the same email shows the same reference and creates nothing; check the case in **Compliance** (source *Form*, email *confirmed by code*, the identity check not done, the bank details masked) and the confirmation email; try a wrong code five times; switch the form off and reload (the neutral page). Close the test cases without a decision (a note is required). Because the data is retained for seven years, **use a throwaway workspace**; real customers' cases cannot be removed.
5. Share a form: copy its address from the settings card. **New address** retires the old one immediately.

## 21. Security notes, tests, and what is not verified

**Security notes.** No personal data in a URL (the code, address, phone and answers travel only in POST bodies and the cookie holds a hash); an uploaded file is stored only after its first bytes say PDF, JPEG or PNG; the form token and the session are bound to **this** form (a token for another form is refused); the session is HttpOnly and SameSite=Lax so another site cannot post with it; the hidden field and the 8-second minimum are speed bumps, the limits (shared across servers) and the optional Turnstile are the real defence; every public answer is `no-store` and is a code, never the database's or the network's words; the CSP of `/c/:slug*` is report-only like the rest of the site.

**Wording needing a native review.** The Malay, Chinese and Korean text of the parent form (`src/lib/compliance/public/words.ts`) and of the emails (`src/lib/compliance/messages.ts`) was written for this build and has not been read by a native speaker. Most worth a careful read: the closure warning (Parent / Child accounts), the declaration, the "what happens next" lines and the safety line, the rejection email's frame, and the Korean honorific level of every sentence. The staff screens' Malay, Chinese and Korean (`Compliance.raise`, `.reports`, `.notices`, `.settings.publicForms`, the sign-off additions) have the same status.

**Tests.** `public/public-helpers.test.ts` (names, amounts, phones, banks, code hashing, attempts, expiry, session signing, the form's rules), `public/service.test.ts` (the whole public flow on the in-memory database: the form behind an address, codes, sessions, the happy path, acknowledgements, the letter, uploads, repeats, the race, contact matching within the workspace), `app/api/compliance/public/public-routes.test.ts` (the three routes end to end), `components/compliance/public/public-form.test.tsx` (the form's markup in four languages and the helpers its handlers call), `service/notices.test.ts` + `messages.test.ts` (every email in four languages, no secrets, once-only claims, failures recorded), `service/raise.test.ts` (the dialog, the raise, duplicates, the request date, the raiser's projection), `reports.test.ts` + `service/reports.test.ts`, `app/api/compliance/part-b-routes.test.ts` (raise needs `compliance.raise` and not the menu, the projection, notices, settings, reports, export, badge, the job), `components/compliance/part-b-render.test.tsx`, `migration-184.test.ts`, capability catalogue / parity / SQL tests, `route-surface.test.ts`, `security-headers.test.ts`.
**Proved in PGlite** (Postgres in WASM, with a stand-in for what 184 reads that has the real tables' NOT NULL columns): 184 three times in a row; `verify-184` ending in `ROLLBACK-OK`; `verify-183` still passing after 184; the catalogue guards for the new objects; four mutations of 184 (restore the raiser's read, drop the unique index, accept any category, drop the notice's unique claim) each made `verify-184` fail. PGlite is not production: `has_capability`, the signup flow and the export functions are simplified, so run `verify-184` against production in a rolled-back transaction before relying on it.
**Not covered by a test** (no DOM renderer): clicking, typing, focus moving to the first problem, the file picker, the Turnstile widget, the four-second wait after "too fast", the toasts after a move, the date-range debounce, the phone layout and the dark appearance. **Not verified at all:** a real mailbox or Resend (an injected sender stands in; nothing was sent), the real private bucket (the in-memory storage stands in), real Cloudflare Turnstile, the running app in a browser, and the `X-Halo-System` mark on a real Microsoft 365 or Gmail message.
