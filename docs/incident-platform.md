# Incident platform: what was built, how to run it, what is uncertain

Built overnight on the branch `incident-platform` (a git worktree at `C:\ClaudeWork\VircleCrm-incident`), from the spec "Incident Platform Spec v2.2".
Nothing is pushed and nothing has been run against the production database. Read **Uncertainty log** first.

## Run order on the Halo PostgreSQL (187.127.105.156)

Migration 206 is already applied. Run these, in order, once, from `supabase/migrations/`. Each is idempotent. Take a database backup first.

| # | File | Adds |
| --- | --- | --- |
| 208 | `208_incident_roles_contacts.sql` | Capabilities `incidents.configure/medical/export`; contacts, roles, role members; `seed_incident_roles` |
| 209 | `209_incident_rules_deliveries.sql` | Notification rules; the message log (`incident_deliveries`); sender and timer functions |
| 210 | `210_incident_steps_role.sql` | A role on every required step; mapping of the built-in packs to roles |
| 211 | `211_incident_sweep_skips_rule_schools.sql` | The old level sweep skips schools that use a "nobody acknowledged" rule; `rule` as an escalation reason |
| 212 | `212_incident_coach_intake.sql` | Coach-portal keys, one-time report links, people named, Return to Play, retention setting |
| 213 | `213_incident_retention_log.sql` | The log of exports and deletes |

Later phases in this branch add further migrations; they are listed at the end of this file.

## Server settings

| Setting | Why |
| --- | --- |
| `NEXT_PUBLIC_SITE_URL` | Halo's public address. Notice links and report links are built from it. Without it nothing can be sent (the message log says so). |
| `INCIDENT_ACK_SECRET` | Signs the one-tap "I have seen this" links. Without it they never verify. |
| `INCIDENT_INTAKE_SECRET` | Signs report links. Falls back to `INCIDENT_ACK_SECRET`, then `AUTOMATION_CRON_SECRET`, then `AUTH_SECRET`. |
| `AUTOMATION_CRON_SECRET` | Already used. The cron `GET /api/incidents/escalation-cron` (every minute) now also runs the rules' timers, sends the outbox and does the daily housekeeping. |
| `STORAGE_PROVIDER` | Already used. Photos from the coach report are stored like other incident files. |

The school also needs: Incidents switched on (platform flag), the School Incident Management template active, and a way to send email (a connected mailbox or the platform sender).

## What exists

* **Sidebar:** Incidents is a group: Overview, All incidents, My tasks, Return to play (nurse), and a Setup area (Setup guide, Roles & contacts, Rules, Coach portal & API, Compliance packs).
* **Roles & contacts:** a role is a job; it has people in order, with backups and away dates; "tell everyone" or "the first available". Per-incident roles (reporter, incident lead, parent or guardian) are worked out from the incident. Old level-2/3 recipients can be brought across with one click.
* **Rules:** one sentence each (When, Only if, Then), starting from recipes; a starter set; edit the wait and the severity; **Try it** shows who would be told and when, and warns about a role with nobody in it.
* **Notification engine:** a raised or closed incident, the timers (nobody acknowledged, a step overdue) and the outbox. Email today; an adapter interface for other channels. One message per address per event, retries with backoff, a message log on every incident, a retry button, minimal content, a one-tap acknowledge link.
* **Required steps** carry a role; **My tasks** shows each person the steps for the roles they hold (they can tick them off without managing incidents).
* **Coach reporting:** keys, one-time links, the hosted phone page (three screens, drafts, offline resend, photos after sending), frame rules for an iframe or web view, Return to Play warnings, the hand-off guide, a test report, the call log.
* **Records:** a retention setting, export before delete, delete with a typed confirmation, a log, and an optional automatic period.
* **Docs:** `incident-coach-portal.md` (for Shoaib), `incident-e2e-test.md` (the gate), `incident-security-review.md`. Tests: `src/lib/incidents/**` including the journey test.

## Decisions made without asking (change any of them)

1. **Evaluation happens in server code, not database triggers.** The raise and close routes and the cron call the engine. Simpler to test and to read than triggers, and equivalent for the school. A change to an incident made by SQL directly would not fire rules.
2. **Acknowledgement is per incident.** One acknowledgement from anyone stops the "nobody acknowledged" chain. Triage (moving the incident out of "reported") also counts. The default wait in the starter rule is 30 minutes.
3. **Schools with a "nobody acknowledged" rule skip the old fixed-level sweep** (migration 211) so nobody is told twice. Other schools are unchanged.
4. **The old "email every manager" message stops** once a school has a rule for newly raised incidents. The in-app notification (database trigger) is unchanged.
5. **Roles are told by address, once per event.** If two rules tell the same person, one message goes out and it asks for acknowledgement if either rule does.
6. **Test reports** (test key) notify only Owners and Admins, and are marked TEST.
7. **A person told about an incident who has a Halo login** is added as a watcher so the link opens the incident under row-level security.
8. **Photos are added after the report is sent** (30 minutes), not with it, so the report itself never waits on an upload.
9. **Away dates, retention dates and "overdue" use UTC dates.** Malaysia is UTC+8, so the day boundary is 08:00 local. Fine for a first release; revisit if a school notices.
10. **English only** for labels. The form schema stores labels as language maps so other languages need no data change. Capability labels exist in en, ms, zh, ko; the new screens are English (the app falls back to English for missing keys).
11. **A new flag `concussion`** exists: the coach form sets it when the student hit their head or seems dazed; a starter rule tells the nurse at once.
12. **Statuses in this build are unchanged** (reported, triaged, contained, investigating, recovered, closed). See the Phase 4 notes below for what was and was not built.

## Uncertainty log

Things I could not verify or had to guess. In rough order of risk.

1. **No database was available.** Migrations 208 to 213 and every query were written against the schema as read from the existing migrations, tested by text and with in-memory fakes, and type-checked. They have not been run. Expect small fixes on first apply (a column name, a constraint). `supabase/migrations/*.sql` are idempotent, so a failed run can be re-run after a fix.
2. **Which database holds migration 206:** you confirmed it is Halo's own PostgreSQL on the VPS. I assumed 206 is applied there; the new migrations depend on it.
3. **Nothing was looked at in a browser or on a phone.** The screens were render-tested (server-side, with sample data and the real English strings), type-checked and linted, not clicked. The iframe, web view, camera and offline behaviours are untested on real devices (see the gate).
4. **The existing raise trigger.** The coach report inserts an incident with no `reporter_id`. The migration-116 triggers (`notify_incident_raised`, auto-watchers, activity log) were read, and use `COALESCE`, but a null reporter is a new case. Check the first test report creates its in-app notifications.
5. **Row-level security for non-managers:** a School nurse who is not a manager sees an incident only because the engine adds them as a watcher when told. Check on UAT that a role holder can open the link.
6. **The default acknowledgement wait** (30 minutes) and every starter value (PDPA 24/72/240 hours, the school-policy rules in migration 206) are unconfirmed. The DPO or school leadership should confirm them.
7. **Guardian contacts** from the booking list are unknown. Until the portal sends them, "Tell parents about injuries" stays off and staff tell parents (Phase 2B).
8. **Hostname:** none assumed. `NEXT_PUBLIC_SITE_URL` must be set per deployment.
9. **Rate limits** are per process memory.
10. **Test failures that are not mine:** about 120 test files fail on the main tree (Share feature keys, auth refactor, others). In the worktree the migration-088 parity tests also fail because the worktree checked files out with Windows line endings; they pass on the main tree. All incident tests pass.
11. **A second session was editing the main checkout** (widget files) while this ran. All this work is in a separate worktree and branch so the two do not mix. One existing test file (`src/proxy.test.ts`) was overwritten by mistake and immediately restored from git; the new proxy tests are in `src/proxy-report.test.ts`.
12. **Korean and other translations** exist only for what the app's tests require (permissions, flags, sidebar). Everything else on the new screens is English.
