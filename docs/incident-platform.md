# Incident platform: what was built, how to run it, what is uncertain

Built overnight on the branch `incident-platform` (a git worktree at `C:\ClaudeWork\VircleCrm-incident`), from the spec "Incident Platform Spec v2.2".
Nothing is pushed and nothing has been run against the production database. **Read the uncertainty log first.**

## Run order on the Halo PostgreSQL (187.127.105.156)

Migration 206 is already applied. Run these, in order, once, from `supabase/migrations/`. Each is idempotent (safe to run twice). Take a database backup first.
208 to 217 were applied to the Halo production database on 2026-11-07 (209 failed once on `incidents.is_test` and was fixed by adding the column there). 218 is new and not yet applied. The SQL was written against the schema as read from the earlier migrations and checked by text tests only.

| # | File | Adds |
| --- | --- | --- |
| 208 | `208_incident_roles_contacts.sql` | Capabilities `incidents.configure/medical/export`; contacts, roles, role members; `seed_incident_roles` |
| 209 | `209_incident_rules_deliveries.sql` | Notification rules (incl. the "still open" timer); the message log (`incident_deliveries`); sender and timer functions |
| 210 | `210_incident_steps_role.sql` | A role on every required step; mapping of the built-in packs to roles |
| 211 | `211_incident_sweep_skips_rule_schools.sql` | The old level sweep skips schools that use a "nobody acknowledged" rule; `rule` as an escalation reason |
| 212 | `212_incident_coach_intake.sql` | Coach-portal keys, one-time report links, people named, Return to Play, the retention setting |
| 213 | `213_incident_retention_log.sql` | The log of exports and deletes |
| 214 | `214_incident_workflow.sql` | Requirements for moving an incident on; approvals |
| 215 | `215_incident_form_versions.sql` | The coach report form, versioned (draft, published, archived); `publish_incident_form` |
| 216 | `216_incident_school_pack.sql` | A school's own compliance pack (built-in packs stay shared; this one is visible only to its school) |
| 217 | `217_incident_webhooks.sql` | Events pushed to the coach portal, with retries |
| 220 | `220_incident_school_categories.sql` | A school's own copy of the incident template, and categories it can hide |
| 219 | `219_incident_portal_platform.sql` | The coach portal as one platform integration: platform keys (no school), the Vircle Group to school mapping with per-school frame origins, the Group ID on each report link. Revokes keys schools made under the old design. |
| 218 | `218_incident_timing_defaults.sql` | The acknowledgement wait as a school setting (default 30 minutes); a school's own deadline (or none) and on/off switch for each built-in required step; the checklist builder reads them |

## Server settings

| Setting | Why |
| --- | --- |
| `NEXT_PUBLIC_SITE_URL` | Halo's public address. Notice links and report links are built from it. Without it nothing can be sent (the message log says so). |
| `INCIDENT_ACK_SECRET` | Signs the one-tap "I have seen this" links. Without it they never verify. |
| `INCIDENT_INTAKE_SECRET` | Signs report links and derives each key's event-signing secret. Falls back to `INCIDENT_ACK_SECRET`, then `AUTOMATION_CRON_SECRET`, then `AUTH_SECRET`. Changing it ends open report links and changes every signing secret. |
| `AUTOMATION_CRON_SECRET` | Already used. The cron `GET /api/incidents/escalation-cron` (every minute) now also runs the rules' timers, sends the outbox, pushes portal events and does the daily housekeeping (03:00 Malaysia time). |
| `STORAGE_PROVIDER` | Already used. Photos from the coach report are stored like other incident files. |

The school also needs: Incidents switched on (platform flag), the School Incident Management template active, and a way to send email (a connected mailbox or the platform sender).

## What exists

* **Sidebar:** Incidents is a group: Dashboard, My tasks, Reports (managers), and a Setup area (Setup guide, Roles & contacts, Rules, Report form, Categories, Keeping records, Our own steps, Timing & deadlines, Compliance packs).
* **Dashboard (`/incidents`):** one page for what used to be Overview, All incidents and Return to play. The four numbers (open, need action now, steps overdue, not yet acknowledged; "need action" is a filter), filters by status, category, severity, what the incident involves, lead, "mine" (lead or reporter), student name, dates raised and free text, and the Board and List views. The nurse (`incidents.medical`) also gets a **Return to play** view: the roster of students with a date still in force. The filters and the view are kept in the address (`?status=reported&mine=1&view=list`), so a view can be bookmarked or sent. The student names come from the same list call and are read as the caller, so a student on an incident the caller cannot open never shows. Only the newest 200 incidents are loaded; Reports covers older ones.
* **Categories (`/incidents/setup/categories`, `incidents.configure`):** the built-in template is shared by every school, so a school first makes its own copy (categories, severity levels and steps), which becomes its active template; incidents already raised keep the template they were raised under. On the copy: add a category (its code comes from the name and never changes), rename it, set the severity it starts at and what it involves, hide it (not offered on the raise form; the coach report form, filters and rules still know it), or delete it when no incident, rule or report form uses it. The last visible category cannot be hidden or deleted.
* **Reports (`/incidents/reports`):** two tabs, Trends and Registers (`?tab=registers`). The old addresses `/incidents/overview`, `/incidents/clearances` and `/incidents/registers` redirect, so links in emails and bookmarks keep working. The coach portal feed (`GET /api/public/clearances`) and the Return to play panel on an incident are unchanged.
* **Roles & contacts:** a role is a job; it has people in order, with backups and away dates; "tell everyone" or "the first available". Per-incident roles (reporter, incident lead, parent or guardian) are worked out from the incident. Old level-2/3 recipients can be brought across with one click.
* **Rules:** one sentence each (When, Only if, Then); a starter set and recipes; write or edit a rule from lists with a live sentence; **Try it** shows who would be told and when and warns about a role with nobody in it. Triggers: raised, nobody acknowledged, a step overdue, still open after N, closed.
* **Notification engine:** a raised or closed incident, the timers and the outbox. Email today; an adapter interface for other channels. One message per address per event, retries with backoff, a message log on every incident with a retry button, minimal content, a one-tap acknowledge link, a "request approval" notice.
* **Workflow:** per status, require a root cause, every required step done, a lead, and/or a role's approval; optionally forbid moving back. Checked on the server for every status change (board, list and page). Approvals: the role holder answers on the incident.
* **Timing & deadlines** (Setup): the acknowledgement wait (starts at 30 minutes; saving it also updates the school's rule that came from the starter recipe), and for every step of the switched-on built-in packs (PDPA, ISO, school policy) the shipped deadline, the school's own hours, no deadline, or the step left off, each with a way back to the shipped value. The PDPA pack carries a note to agree changes with the data protection officer. A change applies to incidents raised from now on. Migration 218.
* **Required steps** carry a role; **My tasks** shows each person the steps for the roles they hold (they can tick them off without managing incidents). A school can add **its own steps** (migration 216).
* **Coach portal is a platform setting.** One key pair (live and test) is made and rotated by the Halo operator, in the operator console. Every portal call carries the school's Vircle Group ID (`X-Vircle-Group-Id`); the operator maps each Group (ID and name) to a school and sets that school's allowed frame origins. Schools do not see or manage any of it: there is no coach-portal page in a school's Setup. The operator console also shows the recent calls and can open a test report for each linked school. Events to the portal carry `data.group_id`.
* **Coach reporting:** one-time links, the hosted phone page (three screens, drafts, offline resend, photos after sending, English/Malay/Chinese), frame rules for an iframe or web view, Return to Play warnings, the hand-off guide, a test report, the call log, optional signed events to the portal.
* **Report form builder:** drag-and-drop fields, steps and options; conditions; category, severity and flag effects per option; wording per language; autosaved draft; strict publish check; versions with compare and restore; live phone preview. A report keeps the version it was filed under, and the incident shows the coach's answers under that version.
* **Records:** registers (injuries, breaches, near misses, property damage, child welfare) with dates and CSV (formula-safe); trends and a repeat-hazard flag; a printable incident record (and JSON evidence pack); a retention setting, export before delete, delete with a typed confirmation, a log, and an optional automatic period.
* **Docs:** `incident-coach-portal.md` (for Shoaib), `incident-e2e-test.md` (the gate), `incident-security-review.md`. Scripts: `scripts/incident-sim-portal.mjs`. Tests: `src/lib/incidents/**`, including the journey test (`e2e/journey.test.ts`).

## Not built (and why)

| Item | Why |
| --- | --- |
| Phase 2B (real portal, guardian contacts) | Needs Shoaib and the booking list; waits for the E2E gate. |
| P2.5 fixed public link fallback | Only needed if the portal merge is late; the key flow works without it. |
| P3.2 category and severity editors, flag mapping | Categories and severities are shared catalogue rows; editing them for one school needs a "clone template" step. The form builder already maps answers to categories, severity bands and flags. |
| P3.4 form import/export, presets | Restore and compare exist; file import/export did not make the cut. |
| P4.3 custom statuses | The six statuses are baked into the database, the board and the old sweep. Requirements per status (built) cover the common need. |
| P4.4 business hours | Timers run on the clock. |
| P6.1 WhatsApp, SMS, push adapters | Needs approved WhatsApp templates and contact consent. The adapter interface and per-contact channel preference exist; a preference with no adapter falls back to email. |
| P6.2 read-only signed links for outside contacts | The acknowledge link works without a login; viewing an incident does not. |
| P6.4 email-to-incident, direct-submit API | Not started. |
| P7.2 DOCX documents per framework | The printable record and the JSON evidence pack cover the content; Forms A to D stay BNM-only. |

## Decisions made without asking (change any of them)

1. **Evaluation happens in server code, not database triggers.** The raise and close routes and the cron call the engine. Simpler to test and read, equivalent for the school. A change made by SQL directly would not fire rules.
2. **Acknowledgement is per incident.** One acknowledgement from anyone stops the "nobody acknowledged" chain. Triage (moving out of "reported") also counts. The starter rule waits 30 minutes unless the school sets another under Timing & deadlines.
3. **Schools with a "nobody acknowledged" rule skip the old fixed-level sweep** (migration 211) so nobody is told twice. Other schools are unchanged.
4. **The old "email every manager" message stops** once a school has a rule for newly raised incidents. The in-app notification (database trigger) is unchanged.
5. **Roles are told by address, once per event.** If two rules tell the same person, one message goes out; it asks for acknowledgement if either rule does. A person who is also the coach who reported gets one message too.
6. **Test reports** (test key) notify only Owners and Admins, and are marked TEST everywhere; they are left out of trends and the "still open" timer.
7. **A person told about an incident who has a Halo login** is added as a watcher so the link opens the incident under row-level security.
8. **Photos are added after the report is sent** (30 minutes), not with it, so the report never waits on an upload.
9. **Away dates, retention and "overdue" use UTC dates.** Malaysia is UTC+8, so the day changes at 08:00 local.
10. **A new flag `concussion`:** the coach form sets it when the student hit their head or seems dazed; a starter rule tells the nurse at once; it raises the severity to at least "could not continue".
11. **Approvals are answered by people who hold the role and have a Halo login.** A manager cannot approve for the Principal. If the Principal has no login, an approval cannot be given (no signed approval link yet).
12. **Workflow requirements have no override.** They apply to everyone, owners included; an admin who needs a move first removes the requirement.
13. **A school's form must file under categories its template has.** The built-in form needs the School Incident Management template; launching under another template answers 422.
14. **Other languages:** the coach page and the built-in form are translated into Malay and Chinese (machine-quality drafts: have a native speaker check them). The admin screens are English. The message test now exempts the `IncidentPlatform` namespace for ko, ms and zh.
15. **Signing secrets are derived, not stored.** A key's event secret comes from the server secret and the key id.

## Uncertainty log

Things I could not verify or had to guess, in rough order of risk.

1. **No database was available.** Migrations 208 to 217 and every query were written against the schema as read from the earlier migrations, tested by text and with in-memory fakes, and type-checked. They have not been run. Expect small fixes on first apply (a column name, a constraint). All are idempotent, so a failed run can be re-run after a fix. `PgDb` quirks (for example how `rpc` unwraps a single row) are handled in `pg-store.ts`.
2. **Which database holds 206:** you confirmed Halo's own PostgreSQL on the VPS; I assumed 206 is applied there and the new migrations depend on it.
3. **Nothing was looked at in a browser or on a phone.** The screens were render-tested (server-side, with sample data and the real English strings), type-checked and linted, not clicked. Drag-and-drop, the iframe, web views, camera and offline behaviour are untested on real devices. The builder's keyboard alternative (up/down buttons) exists but was not tried either.
4. **The existing raise triggers.** The coach report inserts an incident with no `reporter_id` and several new columns. The migration-116 triggers (`notify_incident_raised`, auto-watchers, activity log) were read and use `COALESCE`, but a null reporter is a new case. Check the first test report creates its in-app notifications.
5. **Row-level security for role holders.** A School nurse who is not a manager sees an incident only because the engine adds them as a watcher when told. Check on UAT that a role holder can open the link, and that My tasks lists their steps.
6. **Migration 216 changes the policies on shared catalogue tables** (`incident_standards`, `incident_obligation_rules`, `incident_type_catalogue`, `incident_severity_levels`) from "everyone" to "built-in, or your own school's". It should not change what any school sees, but it touches reads the incident form and settings depend on: test the Settings > Incidents tab and raising an incident right after applying it.
7. **The default acknowledgement wait (30 minutes)** and every starter value (PDPA 24/72/240 hours, the school-policy rules in 206) are unconfirmed, but each school can now change them under Timing & deadlines (migration 218), so nothing needs confirming before a school starts. The shipped values stay the defaults. Migration 218 replaces `incident_sync_obligations` from 206 (`CREATE OR REPLACE`); if the database user does not own that function, the run stops with "must be owner" and needs the owner's account.
8. **Guardian contacts** from the booking list are unknown. Until the portal sends them, "Tell parents about injuries" stays off and staff tell parents (Phase 2B).
9. **Hostname:** none assumed. `NEXT_PUBLIC_SITE_URL` must be set per deployment; the portal never builds links itself.
10. **Security headers.** `/report/*` is excluded from the baseline header rule (which forbids framing) and gets frame-ancestors from the proxy. The rule pattern `/:path((?!report/).*)` follows the existing pattern in `next.config.ts` but was only tested by reading the config object, not by a running server. Verify with a real iframe (see the security review).
11. **Rate limits** are per process memory.
12. **Webhooks** do not resolve DNS at send time, so a host name that later points inside the network is not caught. Registered addresses are limited to public https host names.
13. **Test failures that are not mine:** about 95 test files fail on the main tree too (Share feature keys, auth refactor, an old Supabase CSP assertion, others). The set of failing files on this branch equals the main tree's, except that three migration-text tests (084, 088 parity) fail in the worktree only, because it checked files out with Windows line endings; they pass on the main tree. All incident tests pass.
14. **A second session was editing the main checkout** (widget files) while this ran. All this work is in a separate worktree and branch so the two do not mix. One existing test file (`src/proxy.test.ts`) was overwritten by mistake and immediately restored from git; the new proxy tests are in `src/proxy-report.test.ts`.
15. **Translations** into Malay and Chinese were written by me, not a translator. Korean covers only what the app's tests require.
16. **Workflow checks, the key admin routes and the engine's database store have no route-level tests** (their rules are tested as pure functions; the wiring is type-checked). The journey test runs the whole path in memory.
