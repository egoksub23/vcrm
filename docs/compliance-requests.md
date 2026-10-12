# Compliance requests

Part A, the core. A customer's instruction that Vircle must act on, and be able to prove it acted on, with the reasons: closing an account, withdrawing funds, changing a registered phone number. The agreed spec is `docs/compliance-requests-spec.md`; this document is how it is built, how to switch it on, and what is and is not tested. Migration **183**, verify script `supabase/ci/verify-183-compliance-requests.sql`.

Menu **Compliance** (route `/compliance`, the case at `/compliance/[id]`, settings at **Settings > Compliance**), directly below **KYC review** and above **Secure Sign**. The KYC screen stays at `/kyc`. Product wording is "Compliance requests" and "Secure Sign".

> Part B (built later, by someone else) adds the public parent form, the emails and notifications to the customer, "Raise from Inbox" and "Raise from a ticket", and the reports and CSV. Part A leaves the extension points listed in section 11 and builds none of them.

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

A person who is not a holder of `menu.compliance` cannot see a case through the browser's database access either: the table policies read it (section 4). The one exception is the person who **raised** a case: they can read its row (never its ciphertext or file paths) even without the permission.

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
| awaiting_signoff | rejected | approve | Maker-checker; a reason is required |
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

**Visibility.** Row level security: a case, and through it its events, checklist and file rows, is readable by a member holding `menu.compliance` in that workspace, or by the person who raised it (`created_by = auth.uid()`). Types are readable by `menu.compliance`. Nobody signed in can write any of these tables (no privilege, no policy), and the signed-out role has no access at all. The browser's column privileges leave out `data_enc` and the file `path`. The routes check the permission as well (section 9), and the operator's flag is applied by the app (the database does not know it).

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

It calls `compliance_clock_alert_sweep()`. For every open, unpaused case with a hard stop, in a workspace whose `compliance` flag is **on**, that is within 10 days, within 5 days or at the stop and has not been alerted for that level, it **claims the case** (`clock_alert_level` rises 1, 2, 3 under a row lock with `SKIP LOCKED`, so two overlapping runs cannot both alert and a case never alerts twice for a level), writes a `clock_alert` event and puts an **in-app notification** (`notifications.type = 'compliance_clock'`, with `compliance_request_id`; clicking it opens the case) in front of every holder of `compliance.approve` or `compliance.review`. **It sends no email** (Part B). If the job was down and a case jumped from 12 days to 4 days to go, it alerts once, for the 5-day level.

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

## 11. What Part B plugs into

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
