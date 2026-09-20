# Access control: what enforces each capability

Editable role capabilities (Settings > Roles & permissions) are enforced in three layers: the screens, the API routes (`requireCapability`), and the database. Migration 088 (phase 5) finished the third layer: every capability that guards data in a table is now checked by the database itself, so each switch is real even if someone calls the database with their own login. This page is the inventory, the exceptions with reasons, the benchmark numbers, and how to add a capability.

Roles stay `owner / admin / agent / viewer`. The Owner has everything and is not editable. Defaults equal the old role floors exactly (a test proves it, see [Tests](#tests-and-checks)).

## The helper and why policies do not call has_capability() per row

`has_capability(account_id, key)` is `STABLE`, `SECURITY DEFINER`, has a fixed `search_path`, and its lookups hit primary keys (`role_capabilities (account_id, role, capability)`, `role_capability_defaults (role, capability)`, `capability_catalogue (capability)`). It is right for a function or a one-off check.

In a table policy it would run once per row, and on a bulk write that is 3x slower than the old `is_account_member()` floor (numbers below). So write policies use:

```sql
account_id = ANY ((SELECT public.capability_account_ids('pipelines.configure'))::uuid[])
```

`capability_account_ids(cap)` returns the accounts in which the caller holds the capability (empty for no session, an unknown key, a non-member; one element in practice). The sub-select does not depend on the row, so Postgres evaluates it once per statement (an `InitPlan`, `loops=1` in `EXPLAIN ANALYZE`) instead of once per row. It is the same rule as `effective_capability()` written as one query (Owner true; else the account override, else the default; a grant below `min_grant_role` ignored) and a check in the verify script proves the two agree for every capability, role and override state.

Ownership of the rule: `has_capability()` and `capability_account_ids()` must never disagree. Do not add a third implementation.

## Tiers

| Tier | Meaning | Capabilities |
| --- | --- | --- |
| Database + App | A table policy or a `SECURITY DEFINER` function checks it. Cannot be bypassed by calling the database directly. | every capability that guards data (list below) |
| App | Screens and API routes only, because there is no table for the database to guard. | `menu.*` (13), `reports.view`, `ai.use`, `contacts.merge`, `jira.connect`, `jira.link`, `jira.share-comments` |

Why each App capability stays App:

- **`menu.*` and `reports.view`** show or hide a page. The data behind a page is protected by the action capabilities and the existing read policies, so hiding a menu is a convenience, not a security boundary. The Roles screen tooltip says so.
- **`ai.use`**: the action is a call to the AI provider made by the server. The only client-writable AI table is the citation log (`ai_knowledge_citations`, guarded by `ai.use`), but stopping that write does not stop the spend, so calling the capability database-enforced would overpromise.
- **`contacts.merge`** runs as a service-role function (`merge_contacts`, execute revoked from clients). There is no client path to bypass; the route is the only entry.
- **`jira.*`**: every Jira table has no client write policy at all (`jira_connection_secrets` has no client policy of any kind); all writes are server-side. The route check is the enforcement.

`min_grant_role` (the lowest role a capability can be given to): `agent` for every write capability enforced by the database (so an Agent can be granted `pipelines.configure`, `settings.workspace`, `tags.manage`, ...), still never `viewer` (a Viewer cannot hold a write capability; `set_role_capabilities` refuses). `members.change-role`, `members.remove` and `roles.manage` stay `admin`: their functions also require the Admin rank inside (the hierarchy rules), so a grant below Admin would appear to work and not.

## Inventory: capability by capability

"Old floor" is the minimum role the table policy required before 088 (the default roles of the capability equal it). "Now" is what the database checks.

### Inbox

| Capability | Guards | Old floor | Now |
| --- | --- | --- | --- |
| `messages.send` | `messages` INSERT/UPDATE/DELETE (replies), `message_reactions`; routes `whatsapp/send`, `whatsapp/react`. Also lets a sender INSERT/UPDATE `conversations` (create a conversation for a contact, bump last-message fields), see the guard below | agent | Database + App |
| `conversations.manage` | `conversations` INSERT/UPDATE/DELETE, `conversation_labels`, internal notes (`messages` with `is_internal`), personal `inbox_views` INSERT, `close_conversation_with_note()`, `reopen_conversation()`; routes for labels, notes, personal views | agent | Database + App |
| `comments.moderate` | `comments` UPDATE (reply state, hide, resolve, assign) | agent | Database + App |
| `comments.delete` | `comments` UPDATE that sets `status = 'deleted'` (policy `WITH CHECK`); route `comments/[id]/action` (delete) | admin | Database + App |
| `inbox.shared-views` | `inbox_views` INSERT/UPDATE/DELETE where `owner_id IS NULL` | admin | Database + App |

Conversation guard: `conversations_capability_guard` (BEFORE UPDATE, security invoker) lets a caller who holds `messages.send` but not `conversations.manage` change only `last_message_text, last_message_at, last_channel_type, awaiting_response, updated_at, unread_count`. Assigning, closing, prioritising, pausing the AI or moving to a team need `conversations.manage`. Service-role code and `SECURITY DEFINER` functions run as another database role and are not restricted.

### Contacts and sales

| Capability | Guards | Old floor | Now |
| --- | --- | --- | --- |
| `contacts.edit` | `contacts`, `contact_notes` (yours), `contact_tags`, `contact_custom_values`; routes `contacts/[id]/tags` | agent | Database + App |
| `contacts.merge` | route `contacts/merge` (service-role `merge_contacts`) | agent | App (no client path) |
| `deals.manage` | `deals` | agent | Database + App |
| `pipelines.configure` | `pipelines`, `pipeline_stages` | admin | Database + App |
| `broadcasts.send` | `broadcasts`, `broadcast_recipients`; routes `whatsapp/broadcast*` | agent | Database + App |

### Automation, tickets, tags, knowledge

| Capability | Guards | Old floor | Now |
| --- | --- | --- | --- |
| `automations.manage` | `automations`, `automation_steps` | agent | Database + App |
| `flows.manage` | `flows`, `flow_nodes` | agent | Database + App |
| `tickets.work` | `tickets` INSERT/UPDATE, `ticket_comments` (author's own), `ticket_links`, `ticket_watchers` (yourself), `ticket_attachments` (add, remove your own), `next_ticket_number()` | agent | Database + App |
| `tickets.delete` | `tickets` DELETE | admin | Database + App |
| `tickets.configure-form` | `ticket_field_definitions`; `accounts.ticket_key_prefix` | admin | Database + App |
| `sla.configure` | `business_hours_schedules`, `business_hours_holidays`, `ticket_sla_policies` (086, already database) | admin | Database + App |
| `tags.manage` | `tags` (contact tags and labels), `auto_label_rules`, `accounts.auto_label_ai_enabled` | admin | Database + App |
| `snippets.manage` | `quick_replies` (084) | agent | Database + App |
| `tags.propose`, `snippets.propose` | `propose_tag*`, `propose_snippet*` functions (084) | agent | Database + App |
| `knowledge.draft` | `ai_knowledge_documents` (own drafts), `knowledge_attachments` (own drafts), `knowledge_gaps`, `knowledge_sources` (add, update) | agent | Database + App |
| `knowledge.publish` | `ai_knowledge_documents` (publish, edit or delete anyone's), `knowledge_attachments`, `knowledge_sources`, `ai_knowledge_chunks` | admin | Database + App |
| `knowledge.manage` | `knowledge_collections`, `knowledge_sources` DELETE, `ai_knowledge_chunks` (reindex) | admin | Database + App |

### AI, channels, workspace, people

| Capability | Guards | Old floor | Now |
| --- | --- | --- | --- |
| `ai.use` | `ai_knowledge_citations` INSERT; AI routes | agent | App (see above) |
| `ai.configure` | `ai_configs`, `ai_connections`, `ai_task_routing`, `ai_usage_log` (079) | admin | Database + App |
| `channels.manage` | every `*_config` table, `message_templates` (079) | admin | Database + App |
| `api.manage` | `api_keys`, `webhook_endpoints` (079) | admin | Database + App |
| `jira.connect`, `jira.link`, `jira.share-comments` | `/api/integrations/jira/*` (085), SELECT on sync jobs/events | admin / agent | App (server-only tables) |
| `settings.workspace` | `custom_fields`; `accounts` (name, currencies, default currency, response-time target, status colours) | admin | Database + App |
| `audit.view` | `audit_log` SELECT, removed-items list (082) | admin | Database + App |
| `approvals.review` | `decide_proposal`, `approvals_list`, `approval_pending_edits` SELECT (084, 088) | admin | Database + App |
| `members.invite` | `account_invitations` SELECT/INSERT/UPDATE/DELETE (the token hashes are only readable with it); the before-insert trigger still limits the role to below the inviter's own | admin | Database + App |
| `members.change-role`, `members.remove` | `set_member_role()`, `remove_account_member()` (079) | admin | Database + App |
| `teams.manage` | `teams`, `team_members`, `change_team_members()`, `set_member_teams()` | admin | Database + App |
| `roles.manage` | `set_role_capabilities()`, the change log (079) | admin | Database + App |

The `accounts` row holds columns owned by three capabilities. `accounts_capability_guard` decides per changed column: `ticket_key_prefix` needs `tickets.configure-form`, `auto_label_ai_enabled` needs `tags.manage`, everything else needs `settings.workspace`.

## Inventory: every table with a write policy

All 38 tables below now test the capability. Own-row rules, draft rules, the ticket-link count check, widget visitor policies, soft-delete filters (082) and approval visibility (084) were kept as they were. SELECT policies were not changed except `account_invitations` (needs `members.invite`) and the new `approval_pending_edits`.

| Table | Capability |
| --- | --- |
| `pipelines`, `pipeline_stages` | `pipelines.configure` |
| `custom_fields` | `settings.workspace` |
| `accounts` (UPDATE) | any of the three, then per column (see above) |
| `ticket_field_definitions` | `tickets.configure-form` |
| `auto_label_rules` | `tags.manage` |
| `inbox_views` | insert personal: `conversations.manage`; shared: `inbox.shared-views`. Update or delete your OWN personal view stays open to the owner (own-row clean-up) |
| `knowledge_collections` | `knowledge.manage` |
| `knowledge_sources` | add/update: `knowledge.draft` or `knowledge.publish`; delete: `knowledge.publish` or `knowledge.manage` |
| `ai_knowledge_chunks` | `knowledge.publish` or `knowledge.manage` |
| `ai_knowledge_documents`, `knowledge_attachments` | `knowledge.publish`, or `knowledge.draft` on your own drafts |
| `knowledge_gaps` | `knowledge.draft` or `knowledge.publish` |
| `automations`, `automation_steps` | `automations.manage` |
| `flows`, `flow_nodes` | `flows.manage` |
| `teams`, `team_members` | `teams.manage` |
| `account_invitations` | `members.invite` |
| `tickets` | `tickets.work` (insert, update), `tickets.delete` (delete) |
| `ticket_comments` | `tickets.work` and you are the author (edit, delete) |
| `ticket_links` | `tickets.work` (both tickets in the account) |
| `ticket_watchers` | `tickets.work` and you are the watcher |
| `ticket_attachments` | `tickets.work`; remove: yours, or someone else's only for an admin (allow-list) |
| `deals` | `deals.manage` |
| `contacts`, `contact_tags`, `contact_custom_values` | `contacts.edit` |
| `contact_notes` | `contacts.edit`; edit or remove: yours, or someone else's only for an admin (allow-list) |
| `broadcasts`, `broadcast_recipients` | `broadcasts.send` |
| `ai_knowledge_citations` (INSERT) | `ai.use` |
| `conversations` | insert/update: `conversations.manage` or `messages.send` (+ guard); delete: `conversations.manage` |
| `conversation_labels` | `conversations.manage` |
| `messages` | reply: `messages.send`; internal note: `conversations.manage`. The old single `ALL` policy is split, so a read no longer evaluates a write rule |
| `message_reactions` | `messages.send` |
| `comments` (UPDATE) | `comments.moderate` (`comments.delete` to set `status = 'deleted'`) |

Already on capabilities before 088 (unchanged): every `*_config` table and `message_templates` (`channels.manage`), `ai_configs`, `ai_connections`, `ai_task_routing`, `ai_usage_log` (`ai.configure`), `api_keys`, `webhook_endpoints` (`api.manage`), `tags`, `quick_replies` (084), `audit_log`, `role_capability_log`, and the 086 SLA tables (`sla.configure`).

### Membership only, intentionally

These have write policies that test membership or ownership of the row, not a role, on purpose:

| Table | Rule | Reason |
| --- | --- | --- |
| `notifications` (UPDATE) | `auth.uid() = user_id` | your own read state |
| `profiles` (INSERT/UPDATE) | `auth.uid() = user_id`; `enforce_profile_privilege_columns` blocks role and account changes | your own profile; roles change only through `set_member_role` |
| `ticket_saved_filters` | member and `user_id = auth.uid()` | your own filters, a personal preference |
| `inbox_views` (own personal view update/delete) | member and `owner_id = auth.uid()` | own-row clean-up |
| `member_presence` | no client policy; `touch_presence()` | your own presence |
| Tables with no client write policy (`jira_*` incl. `jira_connection_secrets`, `role_capabilities`, `role_capability_log`, `capability_catalogue`, `role_capability_defaults`, `audit_log`, `approval_pending_edits`, `conversation_events`, `flow_runs`, `flow_run_events`, `automation_logs`, `knowledge_document_versions`, `ticket_activity`, comment tables other than `comments`) | none | written only by server code or `SECURITY DEFINER` functions |

### Left on a role floor on purpose (allow-list)

The verify script fails on any write policy that still tests `is_account_member(..., 'agent'|'admin'|'owner')` unless it is listed here. There are three, all "someone else's item stays with admins", and each still also requires the base capability:

<!-- allow-list:begin -->
- `contact_notes.contact_notes_update`
- `contact_notes.contact_notes_delete`
- `ticket_attachments.ticket_attachments_delete`
<!-- allow-list:end -->

Reason: editing or removing another person's note or attachment is a moderation power with no capability of its own in the catalogue, and inventing one (`contacts.moderate-notes`) would add a switch nobody asked for. Default behaviour is identical (Owner and Admin). If you want them delegable, add a capability and replace `is_account_member(account_id, 'admin')` in those three policies.

Not touched: storage bucket policies (chat-media and others).

### Functions reviewed and left (possible follow-up)

`SECURITY DEFINER` functions that any signed-in role can execute without an ownership check on the id they receive: `_bcast_bump`, `recompute_broadcast_counts`, `claim_ai_reply_slot`, `record_webhook_failure`. They exist for triggers and server code. Revoking `EXECUTE` from `anon` and `authenticated` is the safe fix once every caller is confirmed to use the service role; 088 does not change them.

## Benchmarks

Measured against production inside a rolled-back transaction, with synthetic rows generated in the transaction (`supabase/ci/bench-088-policy-cost.sql`, run after 088 is applied). Agent session, RLS on. Production data is small; the rows below are 12,000 contacts, 12,000 conversations and 24,000 messages (bulk) and 4,000 / 8,000 (single-row loops), on the hosted database, so treat absolute numbers as relative.

Old floor (`is_account_member(account_id, 'agent')` per row, the pre-088 policies) versus the 088 policies (two runs each, alternating):

| Statement | Old floor | 088 |
| --- | --- | --- |
| UPDATE 12,000 conversations | 2342 / 2218 ms | 2252 / 2475 ms |
| UPDATE 12,000 contacts | 1856 / 2333 ms | 1785 / 1676 ms |
| INSERT 5,000 messages | 466 / 490 ms | 396 / 532 ms |
| DELETE 5,000 messages | 461 / 457 ms | 391 / 436 ms |
| UPDATE one conversation by primary key (400 loop) | 1.06 / 1.17 ms/op | 1.11 / 1.08 ms/op |
| INSERT one message (400 loop) | 0.88 / 0.87 ms/op | 0.79 / 0.71 ms/op |
| UPDATE one contact by primary key (400 loop) | 1.19 / 1.20 ms/op | 1.08 / 1.09 ms/op |
| SELECT count(*) FROM messages (read) | 249 / 256 ms | 137 / 127 ms |

The 088 column includes `conversations_capability_guard` on the conversations rows (the old-floor runs had it disabled). Reads on `messages` are faster because the old `ALL` policy also evaluated a write rule on every read.

Why the helper: the naive `has_capability(account_id, 'k')` in the policy, on 20,000 rows: UPDATE conversations 12.4 s and UPDATE contacts 11.8 s against 4.9 s and 3.5 s for the old floor (about 3x); `EXPLAIN ANALYZE` of a 3,000-row conversations UPDATE: 2217 ms with `loops=3000` on the check versus 411 ms with an `InitPlan` `loops=1`. The final helper is a plpgsql function, because the sql version was re-planned in every statement (+0.35 ms on a single-row update); the plpgsql one is noise.

Function-call cost, 3,000 calls: `is_account_member` 50 ms, `has_capability` 572 ms, `capability_account_ids` 97 ms.

Result: every hot path (`messages`, `conversations`, `contacts`) moved; none had to stay on the old floor. Accepted rule: within about 15% or negligible in absolute terms; all rows above are within run-to-run noise or faster.

## pending_edit (approvals)

Before 088, `tags` and `quick_replies` carried a `pending_edit` JSON column, and any member could read the proposed values of an edit with a plain table read. Now:

- The proposed values live in `approval_pending_edits (entity_type, entity_id, account_id, proposed_by, patch, ...)`. Row level security returns a row only to its proposer and to `approvals.review` holders. Nobody writes it directly (`SELECT` only for clients); the approval functions write it.
- The live rows keep `edit_status` (`pending | rejected`, or null) so lists can show a chip, but not the values. The column `pending_edit` is dropped.
- `propose_tag_edit`, `propose_snippet_edit`, `withdraw_proposal`, `decide_proposal`, `approvals_pending_count`, `approvals_list` and `approval_guard` were rewritten for it. Same behaviour: a rejected edit keeps its patch for the proposer until it is withdrawn; approve, withdraw and hard delete clear it (a soft delete keeps it so a restore brings the proposal back).
- Existing pending edits are copied to the side table before the column is dropped (the migration is idempotent: the copy only runs while the column exists). A rolled-back test seeded a pending and a rejected edit on the 084 schema, ran the migration twice, and checked the copy.
- App: `usePendingEdit()` reads the patch for the proposer's edit dialogs (tags, snippets); `chipState()` reads `edit_status` alone.

## How to add a capability

1. `src/lib/auth/capabilities.ts`: add a `def(key, group, defaultRoles, minGrantRole, tier)` line and the key to `CapabilityKey`. Use `"database"` and `"agent"` for a write capability that guards a table.
2. A migration: `INSERT INTO capability_catalogue (capability, min_grant_role, enforced_by) ... ON CONFLICT DO UPDATE` and the `role_capability_defaults` rows (copy the pattern in 084 or 086).
3. Write policies for the tables it guards, with the helper: `account_id = ANY ((SELECT public.capability_account_ids('the.key'))::uuid[])`, split into INSERT / UPDATE / DELETE. Do not call `has_capability(account_id, ...)` per row in a table policy (a vitest fails on it). For a child table, put the test inside an `EXISTS` on the parent. If one row holds columns of different capabilities, add a guard trigger like `accounts_capability_guard`.
4. Routes: `requireCapability('the.key')`; add rows to `capability-parity.test.ts` (route table, old floor, and `PHASE5_ROWS` or `DB_TIER_ROWS` for the table).
5. Screens: `useCapability('the.key')` and `GatedButton` (disable, do not hide).
6. i18n: `Permissions.cap.<id>.label` and `.description` in en and ko.
7. Add the old floor to `old_floors` and a case to the harness in `supabase/ci/verify-088-access-phase5.sql`, then run it.

## Tests and checks

- `capability-parity.test.ts`: every route, table and legacy action maps to a capability whose default equals the old floor; parses 088 and fails if a listed (table, capability) is not in the policies, if a capability literal is unknown, if a write policy calls `has_capability()` per row, if a role floor is left outside the allow-list above; maps routes to the tables they write and fails if a route is weaker than the policy.
- `capabilities.test.ts`, `capabilities-sql.test.ts`: the tier and grant-floor sets, and the SQL catalogue mirrors the TypeScript one (088 is read after the older migrations).
- `src/components/access-gating-render.test.tsx`: a Viewer and a trimmed Agent get disabled write controls on the main surfaces.
- `supabase/ci/verify-088-access-phase5.sql` (rolled back): catalogue tiers and grant floors; `capability_account_ids` equals `effective_capability` for every capability, role and override state; defaults equal the old floors for all four roles; an insert / update / delete harness over 47 table groups and three configurations (defaults, an Agent granted the capability below the old floor, an Admin who lost it) with a Viewer and another account always refused; the special rules (own rows, conversation guard, comment deletion, invitations, functions); `pending_edit` hidden; policy parity (every database-tier capability is referenced by a policy or function, no unknown key, no unlisted role floor, Jira tables have no client write policy); Owner lockout safety; cross-account isolation.

## Applying

Migrations run in numeric order: 086, 087, 088. 088 does not depend on 086 or 087 (their tables already use `has_capability()` or have no client write policy), so it also works if only 088 is applied. The migration is idempotent. Deploy the app with it: an old app build keeps working (it only ever read `pending_edit` through `select *`, which just stops returning it), but the proposer's edit dialog only shows its pending values with the new build.
