# Secure Sign: retention (what is enforced, what is not, what the owner must decide)

Applies from migration `165_sign_retention.sql`. Proved by `supabase/ci/verify-165-sign-retention.sql`.

## 1. What is enforced

- `sign_documents.retain_until` is set when a document is sealed (`sign_finish_sealing`, 158): the day of sealing plus the category's `retention_years`, else the workspace's `sign_settings.retention_years` (default 7, a placeholder; 1 to 50). It is fixed at sealing time: changing the setting later affects only documents sealed afterwards.
- **A completed document cannot be deleted before `retain_until`**, by anyone: the workspace owner, the application (service role) or the database owner. This is a database trigger (`sign_documents_no_hard_delete`), not an application check. A completed document with no date is kept.
- The sealed file and certificate-page rows of a retained document in `sign_document_files` are protected the same way. Other file rows (source, uploads) are not.
- `retain_until` can be moved later, never earlier or cleared. `TRUNCATE` of both tables is refused.
- After `retain_until` a completed document can be deleted (`DELETE /api/sign/documents/[id]`, needs `sign.settings`; the files are removed only after the row went). There is no button for it yet.
- Drafts stay deletable. Documents that were sent but never sealed (declined, expired, voided, failed) are not under retention, and stay undeletable as before (void instead).
- The application deletes the database row first and removes stored files only after that succeeded; a refusal leaves the files where they are.

## 2. The one exception: workspace deletion

`delete_workspace_data` (153) still removes everything. The trigger lets the purge through only when all of these hold: the running role is the owner of `delete_workspace_data`; `vircle.purge_account` names that workspace; a deletion of it has begun (an open row in `workspace_deletions`); and `delete_workspace_data(uuid)` is on the call stack (read from `PG_CONTEXT`). Setting the variable from a request (signed-in or service role) does nothing, and neither does starting a cascade from `accounts` with it set (the verify script tries both). Residual limit: someone who can run SQL as the owner role can fake all four; that person can also drop the trigger.

## 3. What is not enforced

- Files in the `sign-documents` storage bucket: a separate system the database cannot veto. The application never removes a retained document's files; a person with the service key could.
- Copies outside Halo (emailed or downloaded PDFs).
- The period itself: 7 years is a placeholder, not legal advice.

## 4. Open decision for the owner (needs legal advice)

Features doc section 6 proposed that signed documents outlive a deleted workspace as a platform-retained copy. **Not built.** Today workspace deletion removes signed documents and their files, after the 30-day owner request and an export. Options:

1. **Delete everything (today).** Simplest; the workspace's retention duty (if any) is its own, met through the export. Risk: the workspace deletes and loses records it was obliged to keep.
2. **Block deletion while documents are retained.** Honest to "not removable before its date", but a customer cannot leave, which conflicts with erasure rights.
3. **Platform-retained copy** (sealed PDFs, certificates, audit chain, held apart from the rest). Matches the proposal; makes Vircle a long-term custodian of customers' contracts and personal data, with its own storage, access, PDPA and deletion-at-end duties.
4. **Hand-over export only:** the export always includes signed files and certificates, with a warning before deletion lists the retained documents.

The owner decides, with legal advice, the retention period per document type, whether signed records may outlive a workspace, and who is the custodian.
