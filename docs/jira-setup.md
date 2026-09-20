# Linking tickets to Jira (Jira Cloud)

Vircle can create a Jira issue from a ticket, or link an existing one, and from then on the ticket shows the issue's status, assignee and comments, with changes flowing both ways. It works with **Jira Cloud** only (Data Center and Server are out of scope). One Vircle app in the Atlassian developer console serves every customer; nobody installs anything inside Jira.

This page is for **you, the person who runs the Vircle server** (one-time setup), and for **each customer's Jira admin**. The design is in `Vircle-Jira-Integration-Design.docx`; the research behind it lists every source.

> **Status: built, not yet proven against a live Atlassian site.** The whole integration was built and tested against mocked Atlassian responses only. Phase 1 (connect, create, link, live status card) should work as soon as the app is registered. Phase 2 (webhooks, two-way sync) is built to be safe to ship dark. Phase 3 (attachments, custom fields, per-project overrides, bulk actions; Vircle 0.45.0) is built the same way and is **off by default where it writes anything new** (attachments are opt-in; a field only flows once an admin maps it). Read "What is not confirmed" at the end and prove it on a second Atlassian site before you promise it to customers.

---

## 1. One-time setup by the Vircle owner

### 1.1 Register the Atlassian app

1. Open the Atlassian developer console (`developer.atlassian.com/console/myapps`) and choose **Create → OAuth 2.0 integration**. The name is what customers see on the consent screen (for example "Vircle").
2. **Permissions** → add the **Jira API** and configure these scopes (classic scopes; `offline_access` is asked for at sign-in, not here):
   - `read:jira-work`
   - `write:jira-work`
   - `read:jira-user`
   - `manage:jira-webhook`
3. **Authorization** → add **OAuth 2.0 (3LO)** and set the callback URL to **exactly**:

   ```
   https://<your-crm-domain>/api/integrations/jira/callback
   ```

   It must match character for character (scheme, host, no trailing slash). One callback URL per environment. Settings → Integrations → Jira shows the address Vircle will send, so you can copy it from there.
4. **Distribution** → switch **sharing** on. Without it only your own Atlassian account can connect. Sharing does not list the app on the Marketplace and needs no Atlassian approval. Until Atlassian reviews the app, the consent screen tells people it has not been reviewed; an optional review removes that warning and is worth doing before a broad rollout.
5. Copy the **client id** and **client secret** into the server environment (next section) and redeploy.

Scopes Vircle asks for: read and write Jira work, read Jira users, manage Jira webhooks, offline access. It never asks for project or site administration, and **it never calls a delete endpoint** (the only DELETE it can send is for the webhook registrations it made itself; a test enforces this).

### 1.2 Environment variables

Add to `.env.local` on the server (they are documented in `.env.local.example`):

| Variable | Required | What it is |
|---|---|---|
| `JIRA_CLIENT_ID` | yes | Client id from the Atlassian console |
| `JIRA_CLIENT_SECRET` | yes | Client secret. Server only, never sent to the browser. Also used to verify the signed bearer token on webhooks. |
| `JIRA_OAUTH_REDIRECT` | no | Only if the callback address cannot be derived from `NEXT_PUBLIC_SITE_URL` (for example behind an unusual proxy). Must equal the URL registered in the console. |
| `JIRA_WEBHOOK_VERIFY` | no | Set to `path-only` to stop checking the signed bearer token on webhooks (see "What is not confirmed", item 2). Leave unset. |
| `AUTOMATION_CRON_SECRET` | yes, for phase 2 | **Reused**, not new: the same shared secret as `/api/sla/cron` and `/api/automations/cron`, sent as the `x-cron-secret` header. |
| `NEXT_PUBLIC_SITE_URL` | yes | The public **https** address of this deployment. Jira only delivers webhooks to https, and the "Vircle ticket" link inside Jira points here. |
| `ENCRYPTION_KEY` | already set | Encrypts the Jira tokens at rest (the same key as every other channel token). |

If `JIRA_CLIENT_ID` / `JIRA_CLIENT_SECRET` are missing, the feature stays dark: Settings → Integrations → Jira says the operator has to configure it, and the cron endpoint does nothing.

### 1.3 The database migration

Two migrations, both idempotent, apply them in order with your usual `supabase db push` before deploying the app:

- `085_jira_link.sql` creates the tables, the queue and the capabilities.
- `087_jira_depth.sql` (0.45.0) adds attachments both ways (`jira_attachment_map`, `ticket_attachments.source`), custom-field mapping (`jira_field_mappings`, a metadata cache, the `field_state` echo memory), bulk actions (`jira_bulk_batches`, `jira_bulk_items`), the new queue job kinds, the `jira_sync_stalled` notification, the webhook-delivery counters and the personal-data report result. It rebuilds the notification and job-kind CHECK constraints from their **live** definitions, so it is safe whichever of 084, 085 and 086 are already applied. Its proof is `supabase/ci/verify-087-jira-depth.sql` (a rolled-back script; run it together with the migration file, see "Checking the migrations" below).

### 1.4 The scheduled job

The queue processor is `GET /api/integrations/jira/cron`. The VPS runs the app in Docker and has no Vercel-style scheduler, so call it from the host's crontab. Every step inside is idempotent and bounded (a call does at most about 50 seconds of work), and the catch-up spaces itself to five minutes, so **every minute is fine**:

```cron
# Jira link: jobs, catch-up poll (about every 5 min per site), daily webhook renewal, weekly personal-data report
* * * * * curl -fsS -m 58 -H "x-cron-secret: YOUR_AUTOMATION_CRON_SECRET" https://crm.example.com/api/integrations/jira/cron > /dev/null 2>&1
```

Calling it every two or five minutes also works; queued work then waits a little longer. It answers `{"skipped":"jira not configured"}` (HTTP 200) when the Jira variables are not set, so it is safe to install before you register the app.

What one call does, in order:

1. **Jobs**: claims due jobs (`FOR UPDATE SKIP LOCKED`, so two callers never take the same job), runs them, retries with backoff (30 s doubling to 30 min, honouring Jira's `Retry-After`), and dead-letters a job after six attempts. Jobs come from webhooks ("sync issue X"), from ticket status changes ("move the Jira issue") and from "Share with Jira".
2. **Catch-up**: about every 5 minutes, per connection that has live links, one JQL search (`id in (...) AND updated >= -12m`) plus one bulk read, applied exactly like a webhook would have been. This is the safety net for webhooks that never arrive.
3. **Daily**: verifies the token still works (this also keeps the refresh token from idling out after 90 days), renews the webhook's 30-day life or re-registers it if it is missing or its project set changed, matches new members to Jira users by email, prunes old rows.
4. **Weekly**: Atlassian's personal-data report (see "What is not confirmed", item 6). A failed report is retried after six hours, not on every call, and Settings → Integrations → Jira → Diagnostics shows the last result with a **Send now** button.
5. **Self-check** (0.45.0): a connection with live links that has had no successful catch-up for more than 30 minutes is flagged in Diagnostics (red banner), logged as an error event and the workspace owners and admins get one in-app notification a day (`jira_sync_stalled`). Diagnostics also computes it live when opened, so a cron line that stopped is visible even though nothing else ran.

---

## 2. What a customer's Jira admin does

1. **Decide who connects.** Everything Vircle does in Jira appears as the person who connected it. Best: a dedicated **"Vircle Integration"** user with a Jira licence, member of the target projects, allowed to browse, create issues, comment, transition and assign. Comments from Vircle are prefixed with the agent's name ("Maya (Vircle): ...") so engineers know who is speaking.
2. In Vircle: **Settings → Integrations → Jira → Connect Jira** (needs the `jira.connect` permission: Owner and Admin by default). Sign in as that user, choose the site (a picker appears if the user reaches several) and accept.
3. If Atlassian says **a site admin must authorise the app**, the organisation blocks user-installed apps. An admin approves it in Atlassian Administration under **Apps → Connected apps**, then the connect is repeated.
4. In Vircle, choose the **projects** tickets may link to and a default project and issue type, the **mapping** (priority; status both ways), the **direction** switches and the **privacy** options, then try **Create issue** on a test ticket.

A connection breaks when the connecting user changes their password, is removed or deactivated, or the connection is unused for 90 days. It then turns amber with a **Reconnect** button, links **pause** (they are kept, not deleted), and the owners and assignees of linked tickets get an in-app notification.

### Who may do what

| Permission | Default roles | Lets a person |
|---|---|---|
| `jira.connect` | Owner, Admin | Connect, reconnect, disconnect, change settings, see Diagnostics |
| `jira.link` | Owner, Admin, Agent | Create an issue from a ticket, link and unlink, move the Jira issue, Sync now |
| `jira.share-comments` | Owner, Admin, Agent | "Share with Jira" on an internal note, "Comment in Jira" |

Viewers can never be given these. Change them in Settings → Roles & permissions. Every connect, disconnect, link, unlink and settings change is written to the audit log (names and keys only, never tokens).

### What is sent to Jira, and what is kept

- Sent: the subject (cut to Jira's 255 characters), the ticket text as a description (cut at 32,767 characters with a "see the full text in Vircle" link), a link back to the ticket, priority (through the admin's map), labels (`vircle` and the ticket category), and an optional assignee. **The customer's name and email are not sent** unless an admin turns that on, and a preview shows exactly what will be sent before the issue is created.
- Comments go to Jira only when an agent chooses **Share with Jira** on an internal note. Customer-facing messages are never sent.
- Content sent to Jira lands in the customer's own Atlassian data region. Vircle keeps a small cache of Jira data (issue key, status, assignee, priority, comment text that became notes) in its own database. **Disconnect** deletes the tokens and the webhooks; **Remove cached Jira data** also deletes the links, queue and diagnostics. Notes that were copied from Jira stay on the ticket as history.

### First-run checklist (in the product)

Settings → Integrations → Jira → **Connection** shows a five-step checklist that turns green as each step becomes true. It is the in-product version of this page, in the order to do things:

| Step | Turns green when | If it stays grey |
|---|---|---|
| 1. App credentials are on the server | `JIRA_CLIENT_ID` and `JIRA_CLIENT_SECRET` are set | Add them to `.env.local` and redeploy (section 1.2). |
| 2. Connected to a Jira site | A connection exists and is healthy | Press Connect Jira; if Atlassian says a site admin must approve, see section 2. |
| 3. A project is chosen | At least one allowed project, or a default project, is set | Projects tab. |
| 4. Webhooks are registered | Jira accepted the webhook registration | It registers after the first ticket is linked (then daily). Diagnostics → Register webhooks again shows Jira's answer. |
| 5. The first sync has happened | A catch-up succeeded, a webhook arrived or a queued sync job finished | The cron line is not installed or the server cannot reach itself (section 1.4). |

The **Test connection** button under the checklist asks Jira who Vircle is signed in as (`/myself`) and lists the projects that user can browse. If it lists none, the integration user is not a member of any project.

### What to check first when something does not work

| Symptom | Likely cause |
|---|---|
| Cannot connect; message about a site admin | The organisation blocks user-installed apps; a site admin must approve. |
| Connected but a project is missing | The connecting user cannot browse it or lacks Create issues there. |
| Issue creation fails on a required field | The project requires a field Vircle cannot show; use Open in Jira, or ask the admin to relax it. |
| Status changes do not reach the ticket | Webhook missing or expired: check Diagnostics, then Sync now. The catch-up finds it within about five minutes anyway. |
| "Reconnect" banner | Password changed, user removed or deactivated, or unused for 90 days. |
| Ticket cannot move the Jira issue | No workflow transition to that status is available for the issue right now. |
| Nothing syncs at all | Is the cron line installed? Diagnostics shows the queue, the last catch-up and dead jobs. |
| "Not configured" on the Jira card | `JIRA_CLIENT_ID` / `JIRA_CLIENT_SECRET` are not set on the server. |
| Diagnostics shows a red "catch-up has stalled" banner | The scheduled job is not running (cron line missing, wrong secret, server unreachable) or Jira has been failing for 30 minutes. Fix that first; nothing else syncs either. |
| Amber note "deliveries arrived without a signed token" | Atlassian is delivering on the secret address alone. That is accepted by default. Turn on **Require signed deliveries** only after you have seen signed ones arrive (Diagnostics counts both). |
| Every webhook is refused after turning on Require signed deliveries | Atlassian does not sign them the way the code verifies. Turn the setting off; the catch-up poll keeps working. |
| A custom field does not reach Jira | The field is not on that issue's edit screen, the value is not one of the Jira options, or the mapping is "From Jira" only. Diagnostics events show `fields_push_failed` with Jira's reason. |
| "Send to Jira" says the file is too large / of a type Jira cannot take | The site limit (`/attachment/meta`) or the 10 MB default was exceeded, or the file is HTML, SVG or a script. |
| A file on the Jira issue never reaches the ticket | Attachments are off, the file is not an image or document on the allow-list (it is then listed on the card as "not copied" with a link), it is over 16 MB, or the ticket already has 20 files. |
| Bulk "Create Jira issues" leaves tickets out | The review step says why: a required field Vircle cannot fill, a required field only a person can answer, or five links already. |
| Bulk results stay "Waiting" | The scheduled job is not running; the request starts the work itself, but retries after a Jira rate limit need the cron. |

---

## 3. How the two-way sync behaves

- **Status, Jira to Vircle.** By Jira's status **category**: To do → Open, In progress → In progress, Done → Resolved. Admins can override per Jira status name. It only follows a Jira status that **changed** (a ticket an agent resolved is not reopened because the issue is still In progress), never the echo of Vircle's own change, and a **closed** ticket is never reopened. When Jira reaches Done the default is to **notify the ticket's owner and add an internal note**; "set the ticket to Resolved" is opt-in and waits until every linked issue is Done.
- **Status, Vircle to Jira** (opt-in, off by default). A ticket status change asks Jira for the transitions the issue offers right now and takes the **one** that lands on the mapped status, supplying a required resolution if the screen demands it. It never chains transitions. If there is none, Jira is left alone and the card says so. Pending and Closed have no Jira twin unless an admin maps them.
- **Comments.** Every Jira comment becomes an internal note tagged "Jira · name"; edits update the note; a deletion marks it "deleted in Jira" and keeps the text. Comments restricted to a role or group in Jira are not copied. Existing comments at the moment of linking are recorded as seen, not imported. An agent's "Share with Jira" posts "Name (Vircle): text" with a marker, and edits update that Jira comment; a delete in Vircle never deletes in Jira.
- **Assignee.** Jira's assignee is shown on the card. Copying it onto the ticket is optional and needs the member ↔ Jira user match (Settings → Integrations → Jira → People).
- **Echo loops** are prevented by: the Jira comment id recorded the moment Vircle posts it (plus a comment property marker); notes from Jira never sent back; the last status Vircle wrote remembered; changes only applied when the value differs; older events dropped; and a change that came from Jira never queues an outbound change.
- **Problems.** Issue deleted or no longer visible → the link becomes "broken" with a banner (last known data stays; Unlink or Relink). A moved issue is followed by its permanent id. An archived project is not treated as a deletion. Connection lost → links pause. Jira down or rate limited → jobs back off and the card shows the last synced time. A 403 is a clear message on the card and is not retried.
- **Quota.** Since 2026 Jira gives apps like this an hourly points allowance that, by default, is **one pool shared by every customer of the Vircle app**. Vircle never calls Jira to draw a page (the ticket reads its cached row), limits concurrency per site, obeys `Retry-After`, opens an in-process brake when Atlassian says the shared pool is used up, and logs the rate-limit headers (Diagnostics shows them). Ask Atlassian for a per-customer allowance once several customers are live.

---

## 3b. Depth (0.45.0): attachments, custom fields, overrides, bulk

### Attachments (opt-in)

Settings → Integrations → Jira → **Direction & privacy → Attachments**. Off by default.

- **Vircle → Jira.** With the switch on, each file in the ticket's Attachments section has **Send to Jira** (needs `jira.link` and a healthy link). **Send all new attachments** does it for every new file by itself (a database trigger queues it). The file is read on the server from Vircle's own storage (the row's path must be under `account-<id>/tickets/`; a URL is never followed), checked, and posted to `POST /rest/api/3/issue/{key}/attachments` as multipart with `X-Atlassian-Token: no-check`. Limits: the site's upload limit from `GET /attachment/meta` (10 MB when Jira does not say), 20 files per issue, a MIME sanity check (pictures, PDFs and Office files must carry their own signature; HTML, SVG and scripts are refused; text must be text), a sanitised file name. What was sent is recorded (`jira_attachment_map`: ticket file ↔ Jira attachment id, direction, content hash), which prevents sending the same file, or the same bytes under another name, twice and stops the webhook that announces the upload from coming back as a second copy.
- **Jira → Vircle.** With the switch on, files **added to a linked issue after it was linked** are queued (as their own job, five per run) and downloaded through `GET /attachment/content/{id}`. Only Atlassian's redirect is followed, and only to `api.media.atlassian.com`, `media.atlassian.com` or `<site>.atlassian.net`, over https; the signed link is fetched without the bearer token. Up to 16 MB, checked while streaming. Only the types on the storage bucket's allow-list are stored (images and documents; octet-stream is never taken). Anything else is recorded as **skipped (type / size / ticket full)** and listed on the ticket's Jira section with a link to the file in Jira. Stored files are tagged **From Jira**, and are never sent back. Nothing Jira supplies is rendered as HTML. The bucket and its 38 allowed types are unchanged.
- Per project: the two switches can be overridden for one project (see below).

### Custom fields (Settings → Integrations → Jira → Fields)

Map a ticket custom field to a Jira field of a compatible **simple** type, per project (or "every project", modelled on the default project). The Jira fields come from the project's create screen (`createmeta`), cached for 24 hours; **Refresh from Jira** reads them again.

| Ticket field | Can map to |
|---|---|
| Text, long text | single-line text, multi-line text |
| Number | number |
| Date | date |
| Dropdown | single select / radio (the option is matched **by name**, case-insensitively; a name Jira does not have is skipped, never invented) |
| Checkbox | multi-checkbox field, or a **label** (ticked adds the label, unticked removes it, other labels are never touched) |

Everything else (users, versions, components, date-time, cascading selects, multi-selects, read-only fields, custom app fields) is listed as **not supported** and cannot be mapped.

Per mapping: the direction (to Jira, from Jira, both) and **what happens when the value is missing** (skip, clear the other side, or use a default).

- **On create**, mapped fields are part of the issue and shown in the Create dialog's preview (a required Jira field a mapping fills is not asked for again). Bulk create uses them too.
- **On ticket edits** ("to Jira" fields), a database trigger queues a job a few seconds later; the job reads the issue's edit screen and sends **only the fields whose value changed** in one `PUT /issue`.
- **From Jira**, the sync worker asks for the mapped field ids with the issue and applies a value Jira changed to the ticket (as "from Jira": nothing is queued back). Values that already exist when a mapping is made are **recorded, not imported**: only later changes flow.
- **Echo guards.** Per link and mapping Vircle remembers a hash of the value it last pushed or applied and of the value it last saw in Jira. A push of an unchanged value is skipped; a Jira value equal to what Vircle wrote (also after Jira truncated it to 255 characters) is recognised as our own echo; if both sides changed, Jira wins, like status.
- **Rich text.** Jira long-text fields hold Atlassian Document Format. Vircle writes **plain paragraphs** and reads back **plain text**: formatting is not carried across in either direction.

### Per-project overrides (Settings → Integrations → Jira → Projects)

For each allowed project a row can override the default issue type, the priority map (entry by entry), whether the category becomes a label and/or a component (a component only when the project already has one of that name), and each direction switch (comments, status, assignee, attachments, send-all-new). Anything left on "inherit" follows the workspace settings. **The most specific setting wins:** project override, then workspace, then the built-in default. Stored in `jira_connections.settings.project_overrides`.

### Bulk actions (tickets list)

Tick up to 25 tickets; with `jira.link` and an active connection the bar offers:

- **Create Jira issues**: a review step lists each ticket's proposed project, issue type and summary and which ones cannot be created (a required field Vircle cannot fill, a required field only a person can answer, five links already). Confirming queues one job per ticket.
- **Link to Jira issue**: all selected tickets are linked to ONE issue (read once, not once per ticket). A ticket that is already linked is skipped; five links per ticket is still enforced.

Both run through the same create and link code as the single buttons, so the same rules apply. They run as `bulk_item` jobs in `jira_sync_jobs`, respect the per-connection concurrency and the shared-pool brake (a rate limit puts the item back in the queue with backoff), show a progress bar and a per-ticket result, and log every success and failure in `jira_sync_events` (Diagnostics).

### Checking the migrations

Nothing is applied by these commands; the scripts end in a deliberate error that rolls everything back, and a message starting `ROLLBACK-OK` means every check passed:

```
cat supabase/migrations/087_jira_depth.sql supabase/ci/verify-087-jira-depth.sql > /tmp/check087.sql
supabase db query --linked -f /tmp/check087.sql
```

## 4. What is not confirmed (prove it on a second Atlassian site)

The research separated what Atlassian documents from what it does not. Each point below says what the code assumes.

1. **Webhook delivery to a site the app owner does not own.** Atlassian's notes say non-public apps only receive webhooks when the app owner registered them, and do not define "public". Vircle registers the webhook with the connecting user's token on the customer's site. *Must be tested with a second Atlassian site right after enabling sharing.* If it fails, the catch-up poll (every ~5 minutes) still finds changes; the fallback beyond that is polling only, or a small Atlassian Forge app.
2. **The exact signing of webhooks.** Documented only as "a bearer token signed with the app's client secret". The receiver requires the random token in the URL path (constant-time compare) and, **when an `Authorization: Bearer` header is present, requires it to verify as an HS256 JWT signed with `JIRA_CLIENT_SECRET`** (a failing one is rejected and logged). When no bearer is sent it accepts the delivery on the secret address alone and logs that prominently (once a day, in Diagnostics). If real deliveries carry a bearer this code cannot verify, set `JIRA_WEBHOOK_VERIFY=path-only`. **The payload is never trusted either way**: it only names an issue, and the worker re-reads the issue from Jira. Since 0.45.0 every delivery is counted as *signed* or *address only* (Diagnostics → How webhooks arrive, plus an amber note in the Direction tab when unsigned ones arrive), and **Require signed deliveries** (Direction tab, per connection, off by default) refuses anything without a bearer that verifies, also when `JIRA_WEBHOOK_VERIFY=path-only` is set. Turn it on only after you have seen signed deliveries arrive.
3. **Limiting a webhook to linked issues only.** Whether an `issue.property` JQL clause can do it is untested. Vircle registers a webhook filtered to the **projects that have linked issues** (or the allowed projects) and drops events for issues nobody linked. It re-registers daily if the project set changed.
4. **Webhook URL rules for OAuth apps** (one URL per app? same host as the callback?). Untested; the URL includes a per-connection token. If registration is refused the error is logged in Diagnostics and the catch-up carries on.
5. **Token lifetimes.** The access token's expiry is read from the token response (never assumed to be an hour). The refresh token is documented as rotating on every use with a 90-day inactivity limit and a 10-minute reuse leeway; a community-reported absolute limit of 365 days is unconfirmed. Any `invalid_grant` flips the connection to "reconnect needed". Rotation is single-flight (one refresh at a time per connection, across processes) and the rotated refresh token is saved in the same atomic step.
6. **The personal-data report** (`POST /app/report-accounts/`, weekly, batches of 90). The request and response shapes were taken from Atlassian's user-privacy guide and **not proven against a live site**. Vircle sends only Atlassian account ids with a timestamp, erases people Atlassian reports as `closed` and clears cached names for `updated`. It is on by default; **Settings → Integrations → Jira → Direction & privacy → personal-data report** turns it off if the call misbehaves.
7. **Payload details** for issue-deleted and comment events. The worker does not depend on them: any event only queues "read this issue again" and a deletion shows up as a 404 on that read.
8. **Point costs and the shared quota.** The per-call cost table and how a larger allowance is granted are not public. The design keeps calls low; the headers are logged so you can see when to ask.
9. **Granular scopes.** The classic scopes are broad (Atlassian's granular scopes are still labelled beta); the connect screen says so. They can replace the classic ones later.
10. **JQL time zone.** The catch-up uses a relative window (`updated >= -12m`) on purpose: JQL date literals are read in the connecting user's time zone, which Vircle does not know.
11. **Attachments.** Not proven live: the multipart upload shape (`file` part, `X-Atlassian-Token: no-check`), that `GET /attachment/content/{id}` answers with a 303 to Atlassian's media host (the code accepts that host, the site's own `atlassian.net` address and a direct 200, and refuses every other redirect), the `attachment` issue field's shape, and the meaning of `uploadLimit` from `/attachment/meta`.
12. **Custom-field metadata.** The classification of a field from `createmeta` (`schema.type`, `schema.custom`, `allowedValues`, `operations`) and the edit-screen read used before a push (`GET /issue/{key}/editmeta`) are taken from Atlassian's documentation, not proven against a live site. A field type the code does not recognise is listed as not supported rather than guessed.
13. **Bulk quota cost.** A bulk create is about three Jira calls per ticket (create metadata, create, read back) plus the back link. With a shared 65,000-point hourly pool that is fine for 25 tickets; the design still caps a batch at 25.

### A test plan for a second site

1. Create a free Jira Cloud site that Vircle's Atlassian account does not own; add a project and a dedicated "Vircle Integration" user.
2. Enable sharing on the app, connect that site from Settings → Integrations → Jira, link one ticket to an issue, and check Diagnostics shows the webhook as registered.
3. Move the issue to In progress in Jira. If the ticket follows within seconds, webhooks work; if it follows within about five minutes, only the catch-up works (record that).
4. Comment in Jira and check the note appears tagged "Jira · name"; share a note from Vircle and check it appears in Jira once and does not come back as a second note.
5. Turn on "status to Jira", move the ticket, and check the issue moved through one transition and nothing bounced back. Try a status with no transition and check the card says so.
6. Change the connecting user's password and check the Reconnect flow.
