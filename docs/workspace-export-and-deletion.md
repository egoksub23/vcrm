# Workspace export and deletion

For a customer's right to get their data (access) and to have it erased (PDPA, and the same in most other
privacy laws). Built in migration 153, `src/lib/platform/` and the routes listed below.

## What a customer can do

The workspace **owner** (nobody else) goes to **Settings > Workspace > Your data**.

| | |
|---|---|
| **Export** | A zip: a CSV for every table that has rows, the stored files, `manifest.json` (row counts and what was left out) and a README. Channel tokens, API keys, webhook and signing secrets, key hashes and search vectors are never included. "Data only" skips the files. |
| **Delete** | Type the workspace name, optionally give a reason. The workspace **keeps working for 30 days** and every member sees a notice. The owner can cancel any time until the deletion begins. After 30 days the hourly job deletes it. |

## What the operator can do

In the operator console, per workspace: **Delete** (typed name; optionally a shorter wait, or *Delete now*),
**Cancel deletion**, and **Export data**. The operator can export a workspace **only while a deletion is pending**
(so the data can be handed to the owner first); there is no standing way for an operator to read customer data.
A workspace in which a platform operator works cannot be deleted. The owner always gets the full 30 days.

## What a deletion does, in order

1. **Begin** (`workspace_deletion_begin`): suspends the workspace, switches every channel off, writes a tombstone (row counts per table, the logins to delete).
2. **Teardown** (`lib/platform/teardown.ts`): WhatsApp (the app's subscription to the customer's account; the phone number stays registered, it is theirs), Messenger and Instagram page subscriptions, the Gmail watch, the Microsoft 365 mailbox subscription, the Jira webhooks, tokens, links and sync history. Best effort: a dead token never stops the deletion.
3. **Files**: every stored file under `account-<id>/` in all buckets, plus each member's avatar.
4. **Data** (`delete_workspace_data`): one transaction removes every row, including the two append-only logs (`audit_log`, `role_capability_log`), which are purged under a narrow exception that only the function can use.
5. **Logins**: every member and every anonymous web-widget visitor.
6. **Finish**: the tombstone keeps the workspace name, the dates and how many rows each table held. It keeps **no** email and no login ids.

Every step can be run again; progress is written to the tombstone, so a run that stops half way (a deploy, a timeout)
is picked up by the next hourly run.

## What is exported, and how it is kept honest

The table list is **discovered** from the database (every public table keyed by `account_id`, the child tables reached
through a parent, and the workspace row), so a table added later is exported without anyone remembering to list it.
Columns whose names say secret are left out by pattern, and a short list of tables is excluded outright. The check
`supabase/ci/verify-153-workspace-export-delete.sql` fails if:

- a secret-looking column appears in the export;
- a table is added that is neither keyed by the workspace, a listed child, nor reviewed as not tenant data;
- a table keyed by the workspace has no `ON DELETE CASCADE` to it (it would survive a deletion);
- a new restrictive foreign key appears between tables (it could block a deletion);
- after a deletion of a richly seeded workspace, **any row remains** in any table with an account id.

It also proves the two bugs found on the way are fixed (deleting a custom role, or a login that changed a capability,
used to fail once the append-only log held a row) and that the logs stay append-only for everything else.

## Decisions I made (change them if you disagree)

- **Audit trail is purged with the workspace**, not retained (erasure wins; the tombstone is the only record). If your legal advice is to retain it, say so and the purge becomes an anonymise instead.
- **30 days, owner-initiated, cancellable**, with the operator able to shorten it.
- **Export is synchronous and streamed**, not a background job. Fine up to a few GB; for a very large workspace run it from a machine that can hold a long connection.

## Things to know

- **Backups.** Supabase keeps database backups for their retention period. A deleted workspace's rows are in those until they expire; they are not restored into the live database. Tell customers this if asked.
- **Vircle Chat (the gateway)** is a separate database. After a workspace that used it is deleted, run on the gateway server:
  `npm run cli -- delete-workspace --key vcw_... --yes`. It removes the workspace's users, messages and files there. Until then the gateway keeps retrying webhooks that Halo now rejects.
- **Logins** are removed through the Supabase auth admin API after the data. A login that already no longer exists is treated as done.
- **Crontab.** `30 * * * * curl ... /api/platform/deletion-cron` (also in `docs/automations-and-cron.md`). Without it a requested deletion never happens.
- **Large workspaces.** The data deletion is one transaction with the statement timeout lifted; for a very large workspace it can take minutes and holds locks on that workspace's rows while it runs (the workspace is suspended first).

## Routes

| | |
|---|---|
| `GET /api/account/export` | owner: the zip (`?files=0` for data only) |
| `POST` / `DELETE /api/account/deletion` | owner: ask (typed name) / cancel |
| `GET /api/platform/accounts/[id]/export` | operator, only while a deletion is pending |
| `POST` / `DELETE /api/platform/accounts/[id]/deletion` | operator: request (`days`, `now`) / cancel |
| `GET /api/platform/deletions` | operator: which workspaces have a deletion pending or running |
| `GET /api/platform/deletion-cron` | the hourly job (cron secret) |
