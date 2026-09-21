# Changelog

User-visible changes in `wacrm`. Self-hosters: when pulling an update,
check this file for any **migration required** notes and apply the
matching SQL files from `supabase/migrations/` against your Supabase
project before restarting the app.

Versions follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Pre-1.0, `MINOR` bumps cover new modules; `PATCH` bumps cover bug fixes
and polish.

## [0.51.1] — 2026-09-21

- **Ticket comments: a picked @mention now shows as a coloured box while you type** (people in blue, teams in purple, the same colours as a posted comment), so you can see it has been tagged.
- **Ticket comments: pick from the @ list with the keyboard.** Use the up and down arrows to move, and **Enter** or **Tab** to pick the highlighted person or team. The highlighted row is shaded. **Ctrl+Enter** still posts the comment.

## [0.51.0] — 2026-09-21 — **migrations required: 093, 094 and 095** (apply in that order)

- **Ticket @mentions of teams, and “needs your response”.** In ticket comments the @ list now shows People and Teams. Mentioning a team includes all its members (fixed at the moment you post) and adds them as watchers; members without ticket access are skipped and you are told how many. A comment can be **Needs a response** (the default when it names someone) or **FYI only**. Anyone with an open request sees a round **bubble on the Tickets menu** with the number of tickets waiting on them, a **Mentioned me** quick filter, a **Waiting on you** chip on cards and rows, and a banner inside the ticket with **Mark as done** and a link to the comment. A request closes when they reply on the ticket, click Mark as done, the requester deletes the comment or cancels, or the ticket is resolved or closed. Requesters see who is still pending and can nudge (once an hour) or cancel. The notification bell links to the comment. (Migration 095.)
- **Failed sends stay in the chat, with the reason and a Resend button.** If a message cannot be sent (for example WhatsApp #131030, a number that is not on your test number's allowed list, or a closed 24-hour window) it now stays in the conversation as a red **Not sent** message with a plain-English reason, the raw provider code in a popover, and **Resend** and **Delete**. Resend checks the 24-hour rule first and opens Templates when needed, and a double click sends once. Failed messages no longer count in reports or in the AI's view of the chat. (Migration 094.)
- **Fixed: the web widget could not read its own chat.** Live replies never arrived and history was empty after a reload. (Migration 093.)
- **Contacts: Export.** A new **Export** button next to Import downloads a CSV (phone, name, email, company, tags, created) that Import can read back, honouring the search and tag filter, with protection against spreadsheet formulas.
- **Contacts: duplicate phone numbers.** Saving a phone that another contact already has now names that contact and, for people who can merge, offers **Merge these contacts**. The Add Contact text now says only the phone number is required.
- **Fixed:** the top bar said “Dashboard” on Tickets, Knowledge, AI Agents, Flows and Reports; and the bulk **Apply label** listed contact tags as well as conversation labels (the server now refuses a contact-only tag as a label).

## [0.50.2] — 2026-09-21 — **migration required: 093**

- **Fixed: the web widget could not read its own chat.** Live replies never arrived, and after a reload the history came back empty (the widget looked like a new session). Cause: the database rule that lets a visitor read their own messages looked the visitor up in a table that no visitor could read. Migration 093 lets a visitor read only their own row. Apply it, then reload the widget.
- **Voice notes from the widget: choose the microphone.** The widget used the browser's default input, which on a PC with several monitors or headsets can be a silent device. Now a level meter shows while recording, a warning appears if nothing is heard for about 2 seconds with a **Change microphone** button, the chosen microphone is remembered, and an all-silent recording asks before it sends.
- **The widget no longer goes blank.** A message that cannot be displayed shows a placeholder with a download link instead of blanking the chat, a failed history load shows a message with **Try again**, requests time out instead of loading forever, and the chat quietly checks for missed messages.

## [0.50.1] — 2026-09-21

- **Fixed: the chat header was cramped on laptop screens.** With the contact panel open, the customer's name was squeezed out and the badges, timer and the Status, Assign and Priority buttons overlapped each other. The header now wraps onto a second row when there is not enough width.
- **User Guide screenshots.** 29 of the 35 planned screenshots are added. The rest follow after this release.
- No migration.

## [0.50.0] — 2026-09-21

- **User Guide, inside the CRM.** A new **User Guide** item in the sidebar (every role) opens a searchable manual written for agents: getting started, the Inbox (replying, assigning, closing, notes, tags, views, AI help, web chat, social comments), contacts, the Knowledge base, Tickets (including the Jira link), notifications, approvals, reports, troubleshooting and a What's new page. It has a section tree, an “On this page” outline, previous and next links, search (press **Ctrl+K** or **/**), callouts and click-to-zoom pictures. Pages are Markdown files in `content/help/`, see `docs/user-guide.md`. Screenshots are added separately; until then a plain placeholder shows.
- **Fixed: the 24-hour reply lock applied to every channel.** Only WhatsApp has a 24-hour window and templates. Email, web chat, Messenger and Instagram conversations were also locked with “Session expired - use a template” when the customer's last message was more than a day old. The lock and the timer badge now apply to WhatsApp only.
- No migration. Self-hosters: the Docker image now includes `content/`, rebuild as usual.

## [0.49.0] — 2026-09-21 — **migration required: 092**

- **Web widget v2.** The chat widget now looks and behaves like WhatsApp: bubbles, sent / delivered / read ticks, times and day dividers, an emoji picker, voice notes, image and video previews, file chips, a full-screen view on phones, and an unread marker when agents replied while the visitor was away. Visitors can send text, voice, emoji, images, video and files, and agents can send the same back from the Inbox. Files are up to 16 MB, voice notes up to 5 minutes. The widget speaks English, Bahasa Melayu and Mandarin, taken from the page or `data-lang`.
- **In-app identity is now signed.** Settings → Channels → Web Widget has an **In-app identity** card: generate a secret once, then have your app's server sign the phone, email or wallet id (Node, PHP and Python snippets included) and pass it as `data-identity-token` or `VircleWidget.identify({ token })`. Unsigned values no longer count as verified, which closes the hole where anyone with the public widget key could claim any phone number.
- **Matching and merging.** Visitors are matched by phone and by email. A **verified** identity that matches two contacts (one by phone, one by email) merges them automatically into one contact and one chat history. An **unverified** claim never merges: agents see a **Possible duplicate** bar with Merge and Dismiss. Inbox badges: *Verified in-app*, *Unverified web claim*, *Possible duplicate*.
- **Unidentified visitors** choose between “I'm an existing user” (enter the registered phone or email; not found creates a contact tagged *Claims existing user*) and “I'm enquiring” (a short form: name, phone or email, I am a parent / school / merchant / other, message, consent). Enquiries become leads tagged *Web enquiry* and go through your existing routing.
- **Web verification is off for now** (accepted risk: anyone who types a customer's phone or email sees that chat). The setting is built as a switch (none / code by email / code by WhatsApp); only none is live. Identity attempts are rate limited.
- **Migration required: 092** (`supabase/migrations/092_widget_v2.sql`) adds the verification switch and encrypted secret, identity level on visitors, merge suggestions, enquiries and read-tick handling. Apply it before deploying, then run `npm run build:widget` (part of `npm run build`).
- Host apps that embed the widget in a WebView must allow the microphone for voice notes. See `docs/web-chat-widget.md`.

## [0.48.0] — 2026-09-21 — **migrations required: 090 and 091 (091 is optional)**

- **AI inside automations.** A new **AI** group in the automation editor's Add step menu:
  - **AI reply:** writes an answer from the knowledge base and your business context, and either sends it or saves it as a draft note for an agent. It has two outcomes, *Answered* and *Couldn't answer*, so the flow can hand off to a person.
  - **Ask AI (yes/no):** a new kind of Condition. Ask a plain-language question about the conversation, for example “Is the customer asking for a refund?”. An unclear answer counts as No.
  - **AI classify and extract:** pull fields out of the chat (topic, sentiment, order number, name) into variables, contact fields, or existing labels and tags. Values that fail the check are left empty.
  - **AI summarise** and **AI translate** into a variable or an internal note.
- **Test this step.** Every AI step has a Test button that runs it against a conversation you pick and shows the result and the tokens used, without sending anything or changing any data.
- **New trigger “Conversation closed” and a new step “Create ticket”** (with an option for the AI to write the subject and description). Three ready-made templates: AI first response then hand-off, Classify and route, and Close, summarise and open a ticket.
- **Safety and cost:** AI steps use their own routing row in AI Agents → Connections, count against the monthly budget, are limited to 5 per run, treat customer text as data and not instructions, and cannot be activated while AI is not set up.
- **Fixed:** the automation editor's back arrow and name box were hidden behind the sidebar.
- **Cheaper, more reliable AI providers.** OpenAI's gpt-5 family and o-series models now get a low reasoning setting, so they no longer spend tokens and time on hidden reasoning or return an empty reply. Claude models use prompt caching for the repeated part of the prompt when it is long enough (Haiku 4.5 needs 4,096 tokens; a shorter prompt is not cached). AI Agents → Usage shows “Cached input tokens” once migration 091 is applied.

## [0.47.0] — 2026-09-21

- **Emoji everywhere you type.** The chat box has a smiley button that opens a picker with categories, search, a Frequently used row and skin tones. It appears for every channel, in internal comments, in the email editor toolbar, in the Comments inbox reply and private-message boxes, in ticket comments and descriptions, contact notes, the close-conversation and hand-off notes, snippets and the knowledge article editor. **Type `:` and two letters** (for example `:smi`) for suggestions; Enter or Tab inserts, and `:smile:` turns into the emoji when you type the closing colon. It does not trigger for times like 10:30 or links. The emoji list is bundled with the app and only loads when you first open the picker, so nothing is fetched from the internet and the inbox is not slower.

## [0.46.0] — 2026-09-21 — **migrations required: 088 and 089**

- **Every role switch is now enforced by the database.** Until now only some capabilities (channels, AI, API keys, tags, snippets and a few more) were enforced by the database; the rest were enforced by the screens and API only. About 100 database rules on 38 tables now follow the capability switches, so switching something off in Settings → Roles & permissions holds even for someone calling the database with their own login. Defaults are unchanged for all four roles. **You can now also give a role a capability below its old minimum**, for example let Agents configure pipelines. Viewers still cannot hold any write capability and the Owner cannot be locked out. Speed on busy tables was measured and is the same as before (see `docs/access-control-enforcement.md`). Menus, reports and the AI, merge-contacts and Jira switches stay enforced by the app and its API, as explained in the doc and on the screen.
- **Proposed edits are now private.** The values an agent proposes for an existing tag, label or snippet are kept in their own table that only the proposer and reviewers can read; before, any member could read them with a direct database call.
- **Fewer buttons that do nothing.** Buttons that a role cannot use are now disabled with an “Ask an admin” hint across settings, contacts, deals, pipelines, the inbox, broadcasts, automations, flows, knowledge and AI screens.
- **Security tidy-up (089):** four internal database helpers that were callable by anyone are now limited to the server.
- The AI auto-reply take-over now also needs the *Manage conversations* capability, because it assigns the conversation.

## [0.45.0] — 2026-09-20 — **migration required: 087**

- **Jira link, more depth.** **Attachments both ways** (off by default): send a ticket's files to the linked Jira issue, one at a time or all new ones, and bring new Jira attachments onto the ticket, tagged “From Jira”. Only the file types the workspace already accepts are imported; anything else is shown as skipped with a link to Jira. **Custom-field mapping** (Settings → Integrations → Jira → Fields): map ticket fields (text, number, date, dropdown, checkbox) to Jira fields, per project and per direction; mapped fields show in the create-issue preview. **Per-project overrides** for issue type, priority map, category mapping and which directions sync. **Bulk actions** on the ticket list: create Jira issues for up to 25 selected tickets after a review step, or link all selected tickets to one issue.
- **Hardening:** a per-connection “Require signed deliveries” switch and a visible note when Jira webhook calls arrive unsigned; a first-run checklist and Test connection button; an alert if the catch-up sync has stalled for 30 minutes; a “Send now” and last-result display for the personal-data report. Fixed: a failed weekly personal-data report was retried on every cron call; it now backs off six hours.
- Still only tested against mocked Jira responses, never a real Atlassian site.

## [0.44.0] — 2026-09-20 — **migration required: 086**

- **Ticket SLA with business hours.** **Settings → SLA & business hours** has two tabs. *Business hours*: schedules with a timezone, working days with time slots, holidays, one default, copy hours across days, and a Mon–Fri 09:00–18:00 preset. *SLA policies*: an ordered list (first match wins) with conditions (priority, type, label, channel, team), a first-response target and a resolution target, a schedule (or 24/7), pause-while-pending, an at-risk percentage, and a live preview of when a ticket would be due. “Apply to open tickets” gives existing tickets an SLA after a confirmation.
- **The clock runs on tickets.** It runs while a ticket is Open or In progress, pauses while it is Pending, stops when it is Resolved or Closed, and resumes if it is reopened. A badge (On track, At risk, Breached, Paused, Met) with a business-time countdown shows on board cards, the list (new sortable SLA column), the ticket view and the inbox ticket panel. New quick filters **SLA at risk** and **SLA breached**, sort and group by SLA. The assignee (or every admin if unassigned) and watchers are notified once when a ticket is at risk and once when it breaches.
- **Reports → Tickets** gains **SLA compliance**: first-response and resolution met % by priority and by team, and a list of breached tickets.
- New capability *Configure SLA* (Owner and Admin). “First response” means the first internal comment by a Vircle user on the ticket, the same as the existing ticket report; a reply in the linked chat does not count yet. Needs a cron line for `/api/sla/tickets-cron` (see `docs/ticket-sla.md`).
- **Fixed:** the conversation response-time alerts (“sla_breach” notifications) had been failing since 0.39.0 because that notification type was dropped by mistake; migration 086 restores it.

## [0.43.0] — 2026-09-20 — **migration required: 085; new settings: JIRA_CLIENT_ID, JIRA_CLIENT_SECRET**

- **Link tickets to Jira (Cloud, two-way).** Settings → **Integrations → Jira** connects a Jira site through Atlassian sign-in (Owner and Admin, capability *Connect Jira*). On a ticket, a **Jira card** offers **Create issue** (pre-filled from the ticket, with a preview of exactly what is sent; customer name and email are left out unless you turn them on) or **Link existing issue** (up to five per ticket). The card shows the issue key, its live status, assignee and priority from a cached copy, with **Sync now**, **Open in Jira**, **Move Jira issue to…** and **Unlink**. Linked tickets show the Jira key on board cards and list rows.
- **Two-way sync.** Jira status changes update the ticket (To do → Open, In progress → In progress, Done → a note to the owner, or Resolved if you choose); Jira comments appear as internal notes tagged “Jira”; an agent can **Share with Jira** on an internal note; a ticket status change can move the Jira issue when Jira offers a matching step. Updates arrive by Jira webhooks with a catch-up check every few minutes. Loops are guarded so Vircle’s own changes are not echoed back.
- Settings for projects, priority and status mapping, which directions sync (status to Jira is off by default), privacy, user matching and Diagnostics. New capabilities: *Connect Jira*, *Link tickets to Jira*, *Share notes with Jira*. Every connect, link and mapping change is in the audit log.
- **Setup:** see `docs/jira-setup.md` (create the Atlassian app, set the two env variables, add one cron line for `/api/integrations/jira/cron`). **Not yet proven against a real Jira site:** webhook delivery to customer sites, and the exact webhook signature method, are unconfirmed; the catch-up poll works either way.

## [0.42.0] — 2026-09-20 — **migration required: 084 (apply it BEFORE deploying this version)**

- **Propose and approve.** Agents can now *propose* new contact tags, new conversation labels and new snippets, and edits to existing ones. A proposal is saved as **Pending**: only the person who made it and the reviewers can see it, and it is left out of every picker, search, automation and broadcast until approved. Applying an existing label or tag to a chat or contact stays free.
- **Settings → Approvals** (for people with the new *Review proposals* capability, Owner and Admin by default) has a **Pending** and a **Decided** tab. Each row shows the proposer and, for edits, the current version next to the proposed one. **Approve**, **Edit then approve**, or **Reject** with a note (bulk approve too). The proposer is notified of the decision and sees Pending, Pending changes and Rejected chips on their own items, with withdraw, edit and resubmit. Knowledge articles drafted by agents appear in the same queue; approving one publishes it.
- **Turn it on for snippets:** by default agents still edit snippets directly. In Settings → Approvals, the switch **“Agents need approval for: Snippets”** makes agents propose instead (it removes *Manage snippets* from the Agent role). Agents proposing tags and labels is new and needs no switch, because agents could not create them before.
- Three new capabilities in Roles & permissions: *Review proposals*, *Propose snippets*, *Propose tags and labels*. *Manage tags* and *Manage snippets* are now enforced by the database as well, so approvals cannot be bypassed.
- Contact imports by an agent skip unknown tags instead of creating them.

## [0.41.0] — 2026-09-20 — **migration required: 083**

- **Team and Members are now one page.** Settings → **Team** has a **Members | Teams** switch (the old Team members and Teams links still land on it). Members shows each person's role and **every team they belong to** (up to four chips, then “+N” with the full list), presence and last active, with filters (team, role, status), search and sort. Click a person to change their role (only roles below yours), edit their teams, see how many open conversations and tickets they hold, or remove them. Select several people to add or remove them from a team in one go.
- **Invite with teams.** When you invite someone you pick their role (only roles below your own, so an Admin invites Agents and Viewers) and, optionally, the teams they join automatically when they accept. Pending invitations appear at the top of the Members list with who invited them, the role, the teams and when they expire; an invite link can't be shown again, so to re-send one, revoke it and invite again.
- **Teams view** shows each team's colour, members, and how many open conversations it holds, with quick add and remove.
- **Safe removal.** Removing a member also takes them out of every team and either unassigns their open conversations and tickets or hands them to someone you choose, and tells you how many were affected.

## [0.40.0] — 2026-09-20 — **migration required: 082**

- **Audit trail: who added, changed and removed what.** A new **Settings → Audit log** (for people with the *View the audit log* capability, Owner and Admin by default) lists every change to knowledge articles, conversation labels, contact tags, snippets, teams, team members, roles, capabilities, invitations and member removals, plus which sensitive settings (channels, AI, API keys) were changed. It names the person, the action and the item, with filters (person, action, type, date) and **Export CSV**. The log cannot be edited or deleted by anyone.
- **Activity buttons** on knowledge articles, tags and labels, and snippets show that item's history (“Added by Maya, edited by Ravi”), and tag and snippet rows show who added them.
- **Deleting is now reversible.** Deleted articles, tags, labels and snippets go to **Recently removed** (Audit log → second tab) for 90 days with a **Restore** button. A deleted tag name can be used again straight away. Applied labels, contact tag links, teams and team members are still removed for good, but the removal is recorded.
- Only column names are logged for channel, AI and API-key changes, never tokens or secrets. Automations and API calls show as “System” for now.

## [0.39.0] — 2026-09-20 — **migration required: 081**

- **Tickets look and feel like Jira, a little.** Every ticket now has a key such
  as **VIR-12** instead of #12, everywhere a ticket is shown: the list, the board,
  the ticket itself, the "created" message and the ticket history beside a chat. An
  admin can change the prefix in Settings > Ticket form (2 to 6 capital letters or
  digits). It only changes how numbers are displayed; old numbers and links keep
  working.
- **A board.** Tickets are columns: **Open, In progress, Pending, Resolved,
  Closed** (Closed is folded away until you open it). Drag a card to another column
  to change its status, or up and down to put it where you want it in the column;
  it is saved as you drop it and put back with a message if it fails. It works from
  the keyboard too (Space picks a card up, arrows move it, Space drops it, Enter
  opens it). Each card shows the type, key, summary, labels, priority, due date,
  who it is assigned to, the number of comments and the customer. **In progress**
  is a new status.
- **A list with inline edits.** Switch between Board and List at the top (the
  choice is remembered). In the list, change status, priority or assignee right in
  the row, click a column heading to sort, and group by assignee, status or
  priority. Tick rows to change status, assignee, priority or team, or add a label,
  for all of them at once; people who may delete tickets can also delete them
  there.
- **Search and filters.** Search by key (VIR-12), number or words. Quick buttons for
  My tickets, Unassigned, Overdue and Updated today, and filters for assignee, type,
  priority, label, team and (in the list) status. The filters are in the address, so
  a link carries them. **Saved filters** keep a combination for one click, and can be
  shared with everyone in the workspace.
- **A proper ticket view.** Opening a ticket shows a large two-column window (the
  same page also opens at its own link, "Copy link"): click the summary to edit it,
  edit the description, attach files (drop them, paste a picture, or use the button),
  link related tickets (blocks, is blocked by, relates to, duplicates), and read
  Activity with All, Comments and History tabs. Comments can be edited and deleted by
  their author. On the right: a status button, assignee (with "Assign to me"),
  reporter, team, priority, type, **labels**, **due date**, watchers and the customer.
- **Due dates and labels.** Set a due date (red on the card once it is overdue, amber
  on the day) and add free-text labels; labels already used in your workspace are
  suggested.
- **Watching.** The person who raised a ticket and the person it is assigned to
  watch it automatically, and anyone can watch or stop watching. Watchers get a
  notification when the status changes, the ticket is reassigned or someone comments.
  You are never notified about your own change.
- **Create ticket** follows Jira's order (type, customer, summary, description,
  assignee, team, priority, labels, due date, attachments, then your own fields), has
  **Create another**, and its confirmation has an **Open** button.
- **Faster on big accounts.** The list loads the most recently updated 200 tickets
  with **Load more**, each board column loads its first 100 with **Show more**, and
  changes made by others update the one ticket instead of reloading everything.
- Filters and search work on the tickets loaded so far; sending them to the database
  is a follow-up for very large accounts.
- Read-only viewers can look at everything but see the editing controls switched off.
- Reports count In progress tickets as still open. Korean is translated; the other
  languages are not part of this release.

## [0.38.1] — 2026-09-20

- **Voice notes: choose the microphone.** Recording used whichever input the browser had as its default, which on a desk with several monitors (or a headset and a webcam) is often a device that hears nothing, so the note came out silent. The recording bar now has a **Microphone** menu, a live **level meter**, and a **“No sound detected”** warning after two seconds of silence. Pick another microphone and the take restarts on it. The choice is remembered on that computer. If the microphone is unplugged mid-take, the recording is discarded with a message instead of sending silence.

## [0.38.0] — 2026-09-20 — **migration required: 080**

- **Paste an image straight into a knowledge article.** Copy a slide, a screenshot
  or any image and press Ctrl+V in the article editor (or drop image files in). It
  appears in the text at the cursor, uploads in the background, and is scaled down
  first if it is large. No more saving each screenshot as a file and uploading it.
  There is also an **Insert image** button, and you can give any image a caption.
- **Images travel with the answer.** Each pasted image is also an attachment, so
  when an agent inserts the article, or the AI answers from it, the images go out
  in the order they appear, each with its caption. Email replies keep them inline.
  Channels that cannot carry an image get a link instead.
- **Paste an image into a chat message.** In the agent's message box, paste or drop
  an image and it appears as a small chip with a thumbnail; the text goes first and
  then each image. Remove a chip and the unsent upload is deleted.
- Images are kept safe: only this workspace's own uploaded images are allowed in
  an article, and anything else is dropped.

## [0.37.0] — 2026-09-20 — **migration required: 079**

- **Roles & permissions.** A new Settings screen where an Owner or Admin adds or
  removes menus and capabilities for each role. The four roles stay (Owner, Admin,
  Agent, Viewer); nothing changes until someone edits it, because the defaults
  reproduce today's behaviour exactly. About 40 capabilities: 13 sidebar menus plus
  actions such as sending messages, managing tags, publishing knowledge, connecting
  channels and configuring AI. Includes presets (a "Support Manager" profile that
  trims the Admin role), a save bar that lists what will change, a change log, and a
  "By capability" view showing which roles and people hold each one.
- **Rules that stop privilege creep.** The Owner always has everything and cannot be
  edited. An Admin edits only Agent and Viewer. Nobody can grant a capability they do
  not hold. These rules live in the database, not only on the screen.
- **Menus and pages follow the role.** Hidden menus disappear from the sidebar and
  settings rail, and their pages show a friendly "no access" state instead of an
  error. Buttons follow the same capabilities.
- **Database-enforced where it matters most:** channel connections, AI settings,
  connections and usage, API keys and webhooks. Every switch on the screen says
  whether it is enforced by the database or by the app.
- **Security fixes.** About 14 routes had no role check (WhatsApp settings and
  template edits, and the automation and flow lists). WhatsApp saves and template
  edits now check permission before anything is sent to Meta.
- **Invitations and role changes** only reach roles below your own: an Admin can
  invite Agents and Viewers, and can no longer change or remove another Admin.
- **Behaviour change:** the WhatsApp registration check is now for people who may
  manage channels (Owner, Admin), no longer every member.

## [0.36.0] — 2026-09-20 — **migration required: 078**

- **Knowledge base: English is the base, with AI translations you can edit.**
  Open an article and use the new **Translations** card to translate it into
  Bahasa Melayu or Mandarin (one language or all). Each translation is its own
  article, saved as a **draft** with a banner "AI translation: review before
  publishing", and you edit it in the normal editor. Nothing is ever published or
  translated automatically.
- **Out-of-date warning.** If the English changes after a translation was made,
  the translation is flagged; choose **Re-translate with AI** (replaces your
  edits, with a confirmation), **Mark up to date**, or leave it.
- **No doubling in AI answers.** If an article and its translation both match, the
  AI sees only the one in the customer's language. Files are shared with the
  English article unless the translation has its own.
- **Library:** a Translations column with a chip per language (status dot for
  draft, out of date, AI-translated) and a "+" chip that runs the translation.
  Deleting an article that has translations asks first.
- **New AI job "Translate"** on the Connections page and in Usage, so it follows
  your monthly budget and can use its own connection and model.

## [0.35.1] — 2026-09-20

- **Knowledge editor no longer says "unsaved changes" after saving.** The article
  was being saved correctly, but the editor treated loading and locking itself
  during a save as an edit, so the page always warned "You have unsaved changes"
  (and the test box said your edits were not included) even right after Save.
  Only real typing counts now.

## [0.35.0] — 2026-09-20 — **migrations required: 076, 077**

The Knowledge base now follows the design page it was proposed with, plus a
rich-text editor and attachments.

- **Article editor on its own page** (`/knowledge/new`, `/knowledge/[id]`) with a
  WYSIWYG toolbar (bold, italic, underline, headings, lists, quote, link), a
  settings column, Save draft / Publish, and edit history with restore.
- **"Test it: would the AI find this?"** box: runs the same search the AI runs and
  shows which passages would be sent and which fall under the cut-off.
- **Attachments on articles**: images and files (PDF, Word, PowerPoint, Excel,
  images and more, up to 10 per article, images 5 MB, other files 16 MB). When an
  agent inserts the article, or the AI answers from it, the files go with the
  answer. Each file has a "Send with AI answers" switch. A file already sent in a
  conversation is not sent again. Channels that cannot carry a file get a link.
- **Collections** replace free-text categories (existing categories became
  collections). The library has the design's left rail (All articles, Collections,
  Drafts, Review due, Agents only, Gaps, Insights), stat tiles and a fuller table.
- **Add content**: write an article, add Q&A pairs (paste or CSV), upload a file
  (text, Markdown, CSV, Word, PDF) or import a web page with re-sync. Imports
  always land as drafts.
- **Agent access**: a Knowledge tab in the chat's right column (suggested articles,
  search, Insert, Open, Draft with AI, an "Agents only" chip) and `/kb` in the
  message box.
- **The AI shows its sources**: "Based on" chips and "Will attach" chips on AI
  drafts, and an internal "AI answered from" note on auto-replies (never visible to
  the customer). Internal notes no longer reach the AI's prompt.
- **Gaps**: "Save agent reply" drafts an article from the agent's answer after a
  handoff. **Insights**: most used, never used, and handoff-fixing articles.
- Interface strings: English and Korean updated; es and pt are no longer
  maintained.

## [0.34.3] — 2026-09-20

- **Wider inbox list, and the Comments tab is fully visible.** The left column
  of the inbox (Chats, Emails and Comments lists) is wider on large screens, so
  the Comments tab and its count are no longer cut off. All three tabs share the
  same width, so switching between them doesn't shift the layout.

## [0.34.2] — 2026-09-20

- **Instagram "Turn on comments" no longer fails.** Meta rejects `comments` as a
  Page subscription field, so Instagram now only checks that the comment
  permission was granted on reconnect. Turn on `comments` and `live_comments`
  under the Instagram object in the Meta dashboard's Webhooks page.

## [0.34.1] — 2026-09-20

- **Email replies work like Outlook.** Clicking Reply no longer fills the
  screen with the whole email chain. The reply box stays on top with the cursor
  in it, and the quoted message sits underneath in its own scrolling area.
  Long quoted messages in other channels are height-capped too.
- **Snippets and Knowledge slide up.** The two panels no longer replace the
  reply box and push the composer taller; they open as a panel that slides up
  over the chat, with the reply box staying where it is. Close it with Escape,
  by clicking outside, or by picking an item.

## [0.34.0] — 2026-09-20

**Migration required**: apply `075_ai_connections.sql`.

- **AI Connections (phase 2).** AI Agents has a new **Connections** tab.
  - **More than one connection.** The connection from Setup stays the
    default; add others (Kimi, OpenAI, Anthropic, DeepSeek or any
    OpenAI-compatible service) with their own key and model. Keys are tested
    before they are saved and stored encrypted, and a saved connection is tied
    to its service, so a key can never be redirected to another host.
  - **Routing per job.** Choose which connection, and optionally which model,
    serves each job: draft replies, auto-reply, auto-labels, closing notes,
    summaries. Each job can be switched off on its own. A job routed to a
    connection that is later deleted falls back to the default.
  - **Monthly token budget.** Set a ceiling for the calendar month. You get a
    notification at 80%; at 100% AI replies, drafts and the other jobs stop
    with a clear message (agents write by hand; the bot leaves the chat for a
    human) until next month or until you raise it.
  - **Health.** Each connection shows whether it last worked, and **Test**
    re-checks it, so a revoked key shows up before an agent hits it.
  - Usage now breaks spend down by job and by connection. This also fixes the
    Usage tab failing for accounts that had auto-label spend.
- **AI closing notes.** Closing a chat drafts the wrap-up note from the
  conversation and suggests one of your existing conversation labels (never an
  invented one). Edit or ignore both; the note is still required and audited.
- **Conversation summary.** A **Summarise this conversation** button in the
  contact column writes a few lines for whoever picks the chat up. It is shown
  in place and not stored.

## [0.33.0] — 2026-09-20

**Migration required**: apply `074_comments.sql`.

- **Comments inbox.** The inbox now has three tabs: **Chats**, **Emails**
  and **Comments**. Comments collects the public comments on your
  **Facebook Page posts (including ads)**, **Instagram posts** and **TikTok
  videos**, with the post each sits under. From a comment an agent can reply
  publicly, send the commenter a **private message** (Facebook and
  Instagram: once per comment, within 7 days; the message starts a normal
  chat with that person), **hide** or **unhide** it, **delete** it (admins),
  and mark it **resolved** or **spam**. The tab bubble counts comments still
  waiting for a first response; the list updates live.
- **TikTok channel.** Settings → Channels → TikTok connects an account with
  TikTok's own sign-in; comments arrive by webhook (with a **Fetch comments
  now** button as a safety net). Tokens are stored encrypted and refreshed
  automatically. TikTok has no private-message option for commenters and
  only lets you delete your own comments, so those buttons explain why they
  are off. Needs `TIKTOK_APP_ID` / `TIKTOK_APP_SECRET` on the server.
- **Facebook / Instagram comments** are opt-in on the Messenger and Instagram
  channel pages: **Allow comments** reconnects with the extra permissions and
  **Turn on comments** subscribes the Page. Existing DM connections are not
  touched.
- **Try it first.** Settings → Channels has **Add sample comments** so the
  screens can be explored (and shown) before anything is connected. Actions
  on samples are simulated.
- Not yet run against live accounts; see `docs/comments-setup.md`.

## [0.32.0] — 2026-09-20

**Migration required**: apply `073_knowledge_base_v2.sql`.

- **Knowledge base, rebuilt.** It now has its own page (Knowledge, in the
  sidebar) instead of a card inside AI Setup, and both agents and the AI
  use it.
  - **Three languages.** Every article is English, Bahasa Melayu or
    Chinese. Keyword search now works for Chinese (it used to treat an
    unspaced Chinese sentence as one long word), and articles in the
    customer's language rank first. The AI answers in the customer's
    language whatever language the article is in.
  - **From the chat.** A new **Knowledge** tab in the reply box searches
    the base as you chat and suggests articles for what the customer just
    asked; **Insert** drops the text into your reply to edit. Hover any
    message and click **Add to knowledge base** to turn a good answer (or a
    customer's question) into an article.
  - **Articles** can be a Q&A or free text, carry a category and a
    "review by" date, and be marked draft or published. **Let the AI use
    this article** off makes it agents-only: it never reaches an AI prompt.
    Agents' articles are saved as drafts for an admin to publish.
  - **Better AI answers.** The AI searches on the customer's last few
    messages (not just the latest), ignores weak matches, and records which
    article it used (the "AI uses" column).
  - **Unanswered questions.** When the AI hands a chat to a human because
    no article matched, the question lands in an Unanswered list, most
    asked first, with "Write article" pre-filled from the customer's words.
  - **Any embeddings service.** Meaning search no longer needs an OpenAI
    key: set an OpenAI-compatible embeddings URL and model in AI Agents →
    Setup (useful with Kimi, which has none). After changing it, press
    Reindex on the Knowledge page.
  - Existing articles become published, AI-enabled and English.

## [0.31.0] — 2026-09-19

**Migration required**: apply `072_session_notes_edit_delete.sql`.

- **Session notes.** "Notes" is now "Session notes". Every note shows who
  wrote it and when (their name, date, and time). The author can **edit** or
  **delete** their own notes, and admins can change anyone's; an edited note
  is marked "edited", with who and when on hover. Long notes are folded to a
  few lines with **Show more / Show less**. Delete asks for confirmation
  first. The database now enforces this too: until now any agent could change
  or delete a teammate's note, and the author and the written-at time can no
  longer be altered by an edit.
- **Kimi replies are much faster.** Kimi's models "think" before answering by
  default, which is what made replies slow. Thinking is now switched off for
  Kimi (Global and China). If a model can't turn it off, the request is
  retried once with thinking left on and a bigger token allowance, so the
  reasoning can't use up the whole reply.

## [0.30.2] — 2026-09-19

No migration needed.

- **Kimi is the default provider** when you first open AI Agents → Setup, instead
  of OpenAI. Accounts that already have a connection are unchanged.

## [0.30.1] — 2026-09-19

No migration needed.

- **Customer notes moved next to the chat.** The column beside the
  conversation is now split into two halves: ticket history on top, customer
  notes below. Each half scrolls on its own, so a long ticket list never
  pushes the notes out of view. In the notes half, Ctrl+Enter (or Cmd+Enter)
  adds a note. The ticket icon in the chat header now shows or hides both.
- **Fixed: the contact details column wouldn't scroll.** With the customer's
  tags, labels, deals, and session log stacked in it, everything below the
  fold was unreachable. It now scrolls.

## [0.30.0] — 2026-09-19

**Migration required**: apply `070_ai_openai_compatible.sql` and `071_ai_base_url_check_fix.sql`.

- **Connect Kimi, DeepSeek, or any OpenAI-compatible AI** (AI Agents → Setup).
  The provider is now picked from cards — Kimi, OpenAI, Anthropic, DeepSeek,
  Custom — instead of a two-item dropdown. Kimi has a Global / China region
  choice (its keys only work in the region they were created in, and a
  mismatch looks like a bad key, so a rejected Kimi key now says so). Custom
  takes any https base URL; addresses that aren't on the public internet are
  refused. Draft replies, the auto-reply bot, the auto-labeller and the
  knowledge base all work with the new provider without further setup.
- **Test connection** replaces "Test key". It checks the key, reads the list
  of models available on your account, and — once you've chosen a model —
  sends a small test message and shows the time it took and the tokens used.
  The model field offers the models it found, so you don't have to know their
  names. If the key was saved earlier you can re-test without retyping it,
  but only against the provider and URL it was saved for.
- **Data notice.** For third-party providers the form asks an admin to
  confirm that customer messages will be sent to that host. It's recorded once
  per host, and asked again if the host changes.
- Reasoning models that return their thinking separately (some Kimi models)
  are handled: only the final answer is used as the reply.
- Not yet verified against a live Kimi account — see the roadmap.

## [0.29.0] — 2026-09-19

**Migration required**: apply `069_contact_country_language.sql`.

- **Ticket history beside the chat.** A new column between the conversation
  and the contact details lists every ticket for the person you're talking
  to: number, subject, status, priority, age, and a "This chat" marker on
  tickets raised from the open conversation. Filter by All / Active / Done,
  click a ticket to open its full detail, or raise a new one without leaving
  the chat. It updates live. Toggle it with the ticket icon in the chat
  header; it is open by default on wide screens, remembers your choice, and
  only shows on screens 1280px wide or more so the chat keeps its room.
- **Edit the contact from the right-hand column.** Click a name, phone
  number, email, or company to change it (Enter or clicking away saves, Esc
  cancels), and pick a country and language from lists. Numbers are checked
  (7–15 digits) and a number another contact already uses is refused. Viewers
  see the values read-only, and admins get a "Manage" link to custom fields.
- **Preferred conversation language.** The language you set on a contact is
  now used by AI drafts and the auto-reply bot: they answer in that language
  even when the customer's last message is short or in another one, unless
  the customer asks to switch.

## [0.28.0] — 2026-09-19

**Migration required**: apply `068_tag_management_and_currencies.sql`.

- **Tags and Conversation labels are now their own Settings pages**
  (they used to share one "Fields & tags" page). Each is a searchable
  table with a colour picker (presets plus any custom colour), a
  description, an in-use count and who created it. Both have **Export CSV**
  and **Import CSV**: the file needs a `name` column and may have
  `description` and `color`; rows are matched to existing entries by name
  (matches are updated, new names created, blank cells never erase
  anything), and you get a preview of what will happen before anything is
  written. Auto-label rules now live under Conversation labels. Custom
  fields keep their own page.
- **A tag and a label can be kept separate.** An entry is offered as a
  contact tag, a conversation label, or both (a switch in the edit
  dialog). Existing entries stay available in both lists, so nothing
  changes until you split them. Names are now unique per account.
- **Tag colours show in the chat.** Contact tags appear as coloured chips
  on each conversation in the list and under the contact's name in the
  thread header, next to the conversation labels that were already shown.
  The two look different on purpose: tags are outlined pills with a dot,
  labels are filled.
- **Add and remove tags and labels from the right-hand column** while you
  chat: a "+" opens a searchable list, and each chip has a remove button.
  Changes appear in the conversation list straight away.
- **Currencies are editable** (Settings → Deals & currency). Add or remove
  a currency by code and name, or pick from a list of common ones — the
  built-in list now includes Malaysian Ringgit (MYR) and other Asia-Pacific
  currencies. The default currency can't be removed. Existing deals keep
  the currency they were saved with, and a deal whose currency was later
  removed still shows it in the edit form.
- Fixed: the tag list on the old page only showed tags created by *you*,
  so a second admin never saw their colleague's tags.

## [0.27.0] — 2026-09-19

**Migration required**: apply `067_auto_label_rules.sql`.

- **Bulk conversation actions**: in the Inbox's multi-select mode you can
  now assign the selected conversations to an agent (or unassign them),
  close them all with one shared closure note, mark them read or unread,
  or apply a label — alongside "Select all" for the current list. Each
  conversation still gets its own history entry and assignment
  notification, exactly as if you had done it one by one.
- **Auto-labels by category**: Settings → Fields & tags → Auto-labels.
  Map a label to keywords (whole-word or contains) and matching customer
  messages get that label automatically, on every channel. A "test a
  message" box shows which rules would fire. Optionally, turn on the AI
  pass: for a message no keyword matched, on a conversation with no label
  yet, your AI key picks a label from the descriptions you wrote — roughly
  one classification per unlabeled conversation, off by default, with its
  token spend logged like the other AI features.

## [0.26.1] — 2026-09-19

No migration required.

- **Light scrollbars**: scrollbars now follow the app's own light/dark
  theme instead of your operating system's. On the light theme they are a
  thin light-grey thumb over the page background (no dark track), and
  native controls such as date pickers match the theme too.
- **Date rule in the chat**: each new day in a conversation is now marked
  with the date centered on a horizontal line, so it stands out while
  scrolling.
- **Closed / reopened markers in the chat**: when a conversation is
  closed, the thread shows a team-only marker at that point — who closed
  it, when, and the closure note — and the same for a reopen. Conversations
  closed before closure notes existed show a plain "Closed" marker at their
  close time, since who closed them wasn't recorded.
- **Customer-caused reopens are logged too**: when a customer writes to a
  closed conversation and it reopens by itself, the chat now shows a
  team-only "Reopened — customer wrote again" marker (and the session log
  records it) instead of the conversation silently becoming open.

## [0.26.0] — 2026-09-19

No migration required.

- **Chats / Emails tabs in the Inbox**: the conversation column now has
  two tabs above Search — Chats (WhatsApp, Web Widget, Messenger,
  Instagram) and Emails (Gmail, Microsoft 365) — each with a circular
  count of conversations that have unread messages. This replaces the
  separate "Email Inbox" menu entry from 0.24.0 (the sidebar goes back to
  one "Inbox"). The row of channel chips is gone; the channel dropdown is
  scoped to the active tab, and the filters are condensed to a single
  row, with saved views, sort, select, and pending delete as icons.
  Notification and dashboard links to an email conversation open on the
  Emails tab.
- **Fuller ticket performance report** (Reports → Tickets): adds
  first-response time, the share of tickets resolved within 24 hours, the
  live open backlog with its age (under 1 day, 1–3, 3–7, 7+), opened /
  resolved / average resolution broken down by category, priority, and
  team, and an "open now" workload column per agent.
- **Templates moved under WhatsApp**: Settings → Templates is now
  Settings → Channels → WhatsApp → Templates, the first of two tabs
  (Templates, Connection). Old bookmarks and the account-menu Settings
  link still land in the right place.

## [0.25.0] — 2026-09-19

**Migration required**: apply `066_ticket_custom_fields.sql`.

- **Customizable ticket form**: admins can add their own fields to the
  ticket form under Settings → Ticket form — short text, long text,
  number, date, dropdown, or checkbox — mark them required, reorder them,
  and scope each to specific ticket categories (or every ticket). A live
  preview shows the form an agent will see for any category. Fields show
  up in the New Ticket dialog and as an editable Details section on an
  open ticket, and every edit lands in the ticket's activity history.
  Archiving a field hides it from new tickets without losing the values
  old tickets already hold.

## [0.24.0] — 2026-09-19

**Migration required**: apply `064_ticket_activity.sql` and `065_conversation_session_log.sql`, in order.

- **Ticket activity log**: every ticket now has a real history — status,
  priority, category, and assignment changes are logged automatically,
  interleaved with the comment thread in the ticket detail panel so an
  agent can see exactly what happened and when, not just the current
  state. Closes a gap found auditing Ticketing against klink.cloud's
  assign/transfer UX.
- **Ticket performance reporting**: a new Reports → Tickets tab —
  opened/resolved counts and average resolution time over the selected
  date range, plus a tickets-resolved-per-agent breakdown.
- **Conversation session log + required closure notes**: klink.cloud
  parity — closing a conversation now requires a short closure note
  (enforced by the database, not just the dialog), and every
  conversation gets a persistent "session log" in the contact sidebar:
  assigned, reassigned, priority changes, closed, and reopened, each
  with who did it and when. Automation-driven closes are logged too.
- **Email Inbox / Chat Inbox split**: two sidebar entries — Chat Inbox
  (WhatsApp, Web Widget, Messenger, Instagram) and Email Inbox (Gmail,
  Microsoft 365) — filtering the same omnichannel conversation data by
  channel, so email threads no longer mix into the main chat inbox.

## [0.23.0] — 2026-09-19

**Migration required**: apply `059_merge_contacts.sql`, `060_email_subscription_heartbeat.sql`,
`061_message_content_html.sql`, `062_message_pending_delete.sql`, and `063_tickets.sql`, in order.

- **Support tickets**: a new Tickets section — raise a ticket from a
  Contact's profile or straight from an open chat thread (a "Raise
  Ticket" button in the thread header links the ticket back to that
  conversation), then track it through status (Open/Pending/Resolved/
  Closed), priority, category, and agent/team assignment. Tickets get
  their own per-account sequential number (`#1`, `#2`, ...) and a
  comment thread with `@mention` teammate notifications, reusing the
  same assignment/priority/notification machinery conversations
  already use rather than inventing a parallel system.
- **Cross-channel contact merge**: updating a contact's phone number
  now checks whether that phone already belongs to a different contact
  and, if so, offers to merge the two — folding every conversation,
  message, deal, label, and channel identity from the duplicate into
  the kept contact.
- **MS365 subscription keep-alive**: Microsoft Graph mail subscriptions
  are refreshed automatically, tied to real inbox activity (opening the
  Inbox or an email) rather than a blind timer — refreshed only if it's
  been more than 24 hours since the last refresh.
- **Rendered HTML email**: inbound HTML emails (Microsoft 365 and
  Gmail) render as real formatted HTML in a sandboxed view instead of a
  stripped plain-text wall, with a plain-text toggle.
- **WYSIWYG email replies**: replying on an email channel now uses a
  rich-text editor (bold/italic/links/lists) and sends real
  `multipart/alternative` HTML mail, not a plain textarea.
- **Move to Trash / Pending Delete**: any message can be flagged for
  deletion from its hover toolbar — it disappears from the thread right
  away, and an account-wide Pending Delete panel (Inbox toolbar) lets
  an agent restore it or clear it for good, individually or all at
  once.
- Fixed a bug where the message composer's default send channel could
  go stale after replying, showing the wrong channel selected for a
  conversation that spans more than one.
- Inbox views can now be saved as "Email" and "Everything else",
  alongside the multi-select channel filter this builds on.

## [0.22.0] — 2026-09-18

Ships Gmail as a full channel, alongside WhatsApp, the Web Widget,
Messenger, Instagram DM, and Microsoft 365 / Outlook Email — kept as
its own channel type distinct from `email` (Microsoft 365), so an
account can connect one, the other, or both.

**Migration required**: apply `058_gmail_channel.sql`.

- **Connect flow**: a real "Connect Gmail" OAuth flow (Google OAuth
  2.0) under Settings → Channels. Requires a Google Cloud OAuth client
  (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`) — see
  `docs/gmail-setup.md`. Sending works as soon as that's done; shows a
  Reconnect banner if Google access is later revoked.
- **Inbound delivery is a two-part setup, unlike every other channel
  here**: Gmail has no self-service webhook registration, so receiving
  needs a one-time Google Cloud Pub/Sub topic + push subscription the
  operator creates by hand (this app can't do it — it needs
  project-level GCP permissions no Gmail OAuth token grants). The
  Settings panel shows the exact push-endpoint URL (with its
  verification token) to paste into that subscription. A new
  `/api/gmail/watch-renew` cron endpoint (shares
  `AUTOMATION_CRON_SECRET`) renews the underlying watch registration
  before its 7-day expiry.
- **Send + receive**: plain text and a single attachment both ways.
  Replies thread onto the customer's own Gmail conversation — both via
  Gmail's own `threadId` and proper `In-Reply-To`/`References`
  headers, fetched fresh at send time rather than cached. First
  message to a contact who hasn't written in yet falls back to a fresh
  send.
- **Contacts**: matched by email address (case-insensitively) against
  the same `email` field the Microsoft 365 channel already uses — a
  contact who emails either connected mailbox resolves to one contact.
- **Scope for this release**: templates and interactive buttons/lists
  stay WhatsApp-only, same as every other non-WhatsApp channel.
  Attachments beyond a few MB and reconciliation for a Pub/Sub
  notification missed longer than Gmail's history retention window are
  deferred.

## [0.21.0] — 2026-09-18

Ships Microsoft 365 / Outlook email as a full channel, alongside
WhatsApp, the Web Widget, Messenger and Instagram DM.

**Migration required**: apply `056_ms365_email_channel.sql`.

- **Connect flow**: a real "Connect Microsoft 365" OAuth flow (Microsoft
  identity platform v2.0, delegated Graph permissions) under Settings →
  Channels — no manual token entry, and no separate webhook-URL
  registration step: the inbound Graph change-notification subscription
  is created automatically by the connect flow itself. Requires an Azure
  AD app registration (`MS365_CLIENT_ID`/`MS365_CLIENT_SECRET`) — see
  `docs/microsoft-365-email-setup.md`. Shows a Reconnect banner if
  Microsoft access is later revoked or the refresh token expires.
- **Send + receive**: plain text and a single attachment both ways.
  Replies thread onto the customer's own Outlook conversation via
  Graph's `reply` action (not a disconnected new email each time); the
  first outbound message to a contact who hasn't written in yet falls
  back to a fresh `sendMail`.
- **Contacts**: matched by email address (case-insensitively) against
  the CRM's existing `email` field — no new identity column, unlike
  Messenger/Instagram's PSID/IGSID.
- **Keeping it alive**: Graph mail subscriptions expire on their own
  after ~2.94 days and must be renewed — a new
  `/api/email/subscription-renew` cron endpoint (shares
  `AUTOMATION_CRON_SECRET` with the existing automations cron) needs a
  daily-or-more-often pinger hit. See the setup doc.
- **Scope for this release**: templates and interactive buttons/lists
  stay WhatsApp-only, same as every other non-WhatsApp channel.
  Attachments over ~3 MB and delta-query reconciliation for missed
  notifications are deferred.

## [0.20.0] — 2026-09-17

Ships Facebook Messenger and Instagram DM as full channels, alongside
WhatsApp and the Web Widget.

**Migration required**: apply `055_messenger_instagram_channels.sql`.

- **Connect flow**: a real "Connect with Facebook" OAuth flow (Facebook
  Login for Business) under Settings → Channels — no manual token entry.
  Reuses the same Meta App as WhatsApp (`META_APP_ID`/`META_APP_SECRET`);
  add the Messenger and Instagram products plus their permission scopes
  (`pages_messaging`, `instagram_manage_messages`, etc.) to that app in
  Meta for Developers before connecting. Handles a Page picker when an
  admin manages more than one Page, and a Reconnect banner if Facebook
  access is later revoked or expires.
- **Send + receive**: text and media (image/video/audio/document) both
  ways, through each channel's real Graph API — not a WhatsApp-only send
  path pretending to support them. New webhook endpoints
  (`/api/messenger/webhook`, `/api/instagram/webhook`) reuse the exact
  same automation/flow/AI-reply/public-webhook fan-out WhatsApp's webhook
  already runs.
- **Contacts**: keyed by Messenger PSID / Instagram-scoped ID (mirrors
  how a WhatsApp username-only contact is already keyed by BSUID) — no
  phone number required or assumed.
- **Scope for this release**: templates and interactive buttons/lists
  stay WhatsApp-only — neither channel has a real equivalent to WhatsApp's
  pre-approved template system, and Messenger's quick-replies are a
  different enough shape to need their own mapping later. Plain-text and
  media automation sends (`send_message`) already work on both channels
  today.

## [0.19.1] — 2026-09-17

Inbox chat area: removed the decorative doodle background (plain
surface now) and added a sender name label above each message group —
the contact's name on customer bubbles, the agent's (or "Bot") on
outbound ones — so a thread with more than one participant on either
side is unambiguous at a glance.

## [0.19.0] — 2026-09-17

Ships Widget Identity Passing — both halves.

> **Migration required:** apply `supabase/migrations/054_widget_verified_identity.sql`.
> Adds `contacts.wallet_id` and the `merge_widget_guest_contact` SQL
> function. Idempotent.

### Added

- **Verified-user identity passing** — an in-app/WebView widget embed
  can hand the widget a known phone/wallet ID/email at init (loader
  `data-user-*` attributes, or an async
  `window.VircleWidget.identify()` call), skipping any identity prompt
  entirely.
- **Self-service identity linking** — a plain web visitor is now asked
  "Are you already a Vircle user?" instead of a mandatory phone gate;
  declining starts a plain anonymous guest session. A guest can later
  link their account, folding their guest history into the identified
  contact.

## [0.18.0] — 2026-09-17

Closes the last 2 Assignment Strategies P1 gaps: least-loaded routing
and an online-only filter.

> **Migration required:** apply `supabase/migrations/053_assignment_routing_strategies.sql`.
> Adds `pick_least_loaded_agent` / `pick_least_loaded_team_member`, and an
> `online_only` parameter to all four assignment-picker functions. Idempotent.

### Added

- **Least-loaded assignment** — new `assign_conversation`/`assign_to_team`
  mode that routes to the agent (or team member) with the fewest
  currently open conversations, instead of round-robin rotation.
- **Online-only routing filter** — a checkbox on both steps' round-robin
  and least-loaded modes that skips agents who aren't currently online
  (same "online" definition the presence dots already use).

## [0.17.0] — 2026-09-17

Ships the remaining 5 Reporting Suite follow-ups: Assignments,
Leaderboard, Users, Lifecycle, and Broadcasts reports.

> **Migration required:** apply `supabase/migrations/052_contact_lifecycle_stage.sql`.
> Adds `contacts.lifecycle_stage` (lead/active/customer/churned, default 'lead')
> and `lifecycle_stage_changed_at`. Idempotent.

### Added

- **Reports: Assignments** — conversation distribution across agents and
  teams for the selected range.
- **Reports: Leaderboard** — agents ranked by message volume (ties broken
  by conversations closed), with conversations assigned/closed and
  average response time per agent.
- **Reports: Users** — per-teammate activity summary (message volume,
  conversations, response time, member since) — explicitly not a login/
  activity audit log, which Vircle doesn't track yet.
- **Reports: Lifecycle** — current contact distribution across
  lead/active/customer/churned, plus this-period stage moves.
- **Reports: Broadcasts** — account-wide, cross-campaign send/delivery/
  read/failed trend.
- **Contact lifecycle stage** — settable from the contact form, or via a
  new `set_lifecycle_stage` automation step.
- `messages.sender_id` (previously populated only for internal comments)
  is now also set on ordinary outbound agent sends, powering the
  Leaderboard/Users reports' per-agent attribution.

## [0.16.0] — 2026-09-17

Closes the Navigation & Layout roadmap gap: a collapsible sidebar.

### Added

- **Collapsible hover-expand sidebar** — a pin/collapse toggle (desktop
  only) switches the left nav between always-expanded (unchanged default)
  and an icon-only rail that hover-expands to show labels without
  reflowing the page. Preference persists per-browser.

## [0.15.0] — 2026-09-17

Closes the Inbox Views roadmap gap: saved/custom inbox filter combinations.

> **Migration required:** apply `supabase/migrations/051_inbox_views.sql`.
> Adds the `inbox_views` table (personal or account-shared named filter
> combinations). Idempotent.

### Added

- **Saved inbox views** — a "Views" dropdown in the Inbox lets you save
  the current filter combination (status, tags, team, labels, channel,
  priority, sort) under a name and re-apply it later instead of rebuilding
  it every session. Personal views are visible only to you; admins can
  also save a shared view visible to the whole account.

## [0.14.0] — 2026-09-17

Closes two gaps flagged in the Conversation Labels roadmap audit.

### Added

- **`conversation_label_added` automation trigger** — automations can now
  react to a conversation being labeled (previously only the reverse
  direction existed: an automation step could apply a label, but nothing
  could fire *because of* one). Mirrors the existing `tag_added` trigger's
  chain-depth guard so label-triggered automations can't loop forever.
- **Bulk label apply** — a "Select" toggle in the Inbox conversation list
  turns on multi-select; with one or more conversations selected, "Apply
  label" applies a label to all of them in one action instead of one at a
  time in the thread view.

## [0.13.0] — 2026-09-17

Adds a Reports section — Conversations, Responses, Resolutions,
Messages, and Contacts trends.

> **Migration required:** apply `supabase/migrations/050_conversation_closed_at.sql`.
> Adds `conversations.closed_at`, stamped whenever a conversation transitions to
> `closed` (the dashboard Status control and the `close_conversation` automation
> step) and cleared on reopen; backfills already-closed conversations from
> `updated_at` as an approximation (flagged in the Resolutions report UI).
> Idempotent.

### Added

- **Reports** (new sidebar item) — five report tabs, each with a date-range
  preset picker (Today / 7 / 14 / 30 / 90 days / This month) and a "vs.
  previous period" comparison on every tile:
  - **Conversations** — opened/closed counts and a daily bar chart.
  - **Responses** — average first-response time.
  - **Resolutions** — average open→closed duration (needs the `closed_at`
    migration above; conversations closed before this release show an
    approximate duration).
  - **Messages** — incoming vs. outgoing volume.
  - **Contacts** — new contacts over time.
  
  Client-side aggregation, same pattern (and same scale caveat) as the
  existing Dashboard widgets — a note in `src/lib/reports/queries.ts` flags
  the SQL-RPC migration path for when a tenant's dataset outgrows it.

## [0.12.0] — 2026-09-17

Adds an "aging response" indicator and SLA breach alerts.

> **Migration required:** apply `supabase/migrations/049_sla_response_targets.sql`.
> Adds `accounts.sla_response_minutes` (default 30), `conversations.awaiting_response`
> / `last_customer_message_at` / `sla_notified_at`, backfills both from existing
> message history, extends `bump_conversation_on_inbound` to maintain them, and
> widens `notifications.type` to include `sla_breach`. Idempotent.

### Added

- **Aging response indicator.** A conversation whose most recent message is
  from the customer — and hasn't been answered yet, on either channel — now
  shows a small "waiting" chip in the Inbox list and the thread header, with
  elapsed time and a color that flips from amber to red once it passes the
  account's response target. Clears the moment anyone (or any bot/automation)
  replies.
- **Response time setting.** Settings → Response time — a single account-wide
  target, in minutes (default 30), admin+ to edit.
- **SLA breach alerts.** New `GET /api/sla/cron` sweep (same
  `AUTOMATION_CRON_SECRET` auth as the existing automation/flow cron routes —
  point an external scheduler at it, e.g. every 5 minutes) notifies the
  assigned agent, or every account admin/owner for an unassigned conversation,
  once a wait exceeds the target. Notifies once per wait cycle, not on every
  sweep run.

## [0.11.0] — 2026-09-17

Merges a contact's WhatsApp and Web Widget conversations into a single
thread.

> **Migration required:** apply `supabase/migrations/048_merge_channel_conversations.sql`.
> This migration mutates existing data — for any contact who has both a
> WhatsApp and a Web Widget conversation, it merges them into one (keeping
> the earlier-created row, moving all messages/labels/reactions/deals/
> notifications/AI-usage-log rows onto it, then deleting the other) before
> dropping `conversations.channel_type` in favor of a new per-message
> `messages.channel_type` and a `conversations.last_channel_type` rollup.
> Idempotent — safe to re-run.

### Added

- **Omnichannel conversation merge.** A contact who has messaged via both
  WhatsApp and the Web Widget now has exactly one conversation, with full
  history from both channels in a single thread, instead of two separate
  ones. Each message bubble shows a small icon for which channel it came
  in/went out on; the thread header's channel badge and an agent's reply
  now follow `last_channel_type` — whichever channel the customer most
  recently used — instead of a fixed per-conversation channel.

### Fixed

- **Web-widget conversations could only ever receive one agent reply.**
  Every agent-sent message on a widget conversation persisted
  `message_id: ''` (no Meta wamid), which collided with itself under the
  `(conversation_id, message_id)` unique index on the second such reply,
  throwing a Postgres unique-violation and silently failing the send. Now
  persists `NULL`, which the index already treats as distinct.
- **AI auto-reply and the automation engine's `send_message` step
  couldn't actually reply to a web-widget conversation**, despite both
  being documented as channel-agnostic. Both called a WhatsApp-only Meta
  sender with no widget branch (AI auto-reply borrowed the Flow runner's
  sender; `send_message` had its own separate one), so either would throw
  "contact has no usable WhatsApp address" against a widget contact. Both
  now delegate to the same channel-aware core the dashboard composer
  uses.

## [0.10.0] — 2026-09-17

Adds a priority field to conversations.

> **Migration required:** apply `supabase/migrations/047_conversation_priority.sql`
> (adds `conversations.priority` — `urgent` / `high` / `normal` / `low`,
> default `normal` — plus a supporting index. Idempotent.)

### Added

- **Conversation priority.** A Priority control in the thread header
  (next to Status/Assign/Team), a priority filter and a Recent/Priority
  sort toggle in the Inbox sidebar (sort defaults to Recent — switching
  it doesn't change what's shown, only the order), and a flag badge on
  non-normal rows. A new `set_priority` automation step lets a
  condition on a contact field (e.g. a "VIP" custom field) set priority
  to `urgent` automatically.

### Fixed

- **`close_conversation` could close the wrong conversation for a
  contact.** Since 0.9.0, a contact can have both a WhatsApp and a
  web-widget conversation. The step closed by `account_id` +
  `contact_id`, which was harmless when a contact could only ever have
  one conversation but closed *both* once that stopped being true.
  Scoped to the one conversation that actually triggered the
  automation instead.

## [0.9.0] — 2026-09-17

WhatsApp is no longer the only channel. Adds Settings → Channels
(WhatsApp relocated there unchanged, plus "coming soon" entries for
Instagram/Messenger/Email/SMS) and a real second channel: a self-hosted,
embeddable web-chat widget.

> **Migration required:** apply `supabase/migrations/046_channels.sql`
> (adds `conversations.channel_type`, `contacts.widget_visitor_id`, the
> `web_widget_config` and `widget_visitors` tables, and additive RLS
> policies scoping an anonymous widget visitor to their own
> conversation. Idempotent.) Also requires a one-time, non-SQL step:
> enable **Anonymous Sign-ins** in the Supabase dashboard
> (Authentication → Sign In / Providers) — the widget can't start a
> visitor session without it. See `docs/web-chat-widget.md`.

### Added

- **Settings → Channels.** Replaces the old flat WhatsApp settings
  page with a sub-nav: WhatsApp (moved, unchanged), Web Widget (new),
  and UI-only "coming soon" cards for Instagram/Messenger/Email/SMS.
- **Embeddable web-chat widget.** A small self-contained Preact bundle
  (`widget/`, built by `scripts/build-widget.mjs`, wired into
  `npm run build`) mountable via Shadow DOM with a single
  `<script data-widget-token>` tag — works on any website or inside a
  mobile app's WebView. Visitors authenticate via Supabase anonymous
  auth; reads (history, live updates) go straight to Supabase under
  RLS, sends go through a new public `/api/widget/message` route so
  they run the same automations/AI-reply/outbound-webhook fan-out a
  WhatsApp inbound message gets.
- **Channel-aware sends and automations.** `sendMessageToConversation`
  skips Meta entirely for a widget conversation; WhatsApp-only
  automation step types (templates, interactive buttons/lists) now
  fail with a clear logged error on a widget conversation instead of
  erroring against Meta. The visual Flow builder is WhatsApp-only for
  now — see `docs/web-chat-widget.md` for why.
- **Inbox channel badges/filter.** Conversation rows and the thread
  header show which channel a conversation is on; the sidebar gets a
  channel filter alongside the existing team/label filters.

Full setup guide: `docs/web-chat-widget.md`.

## [0.8.1] — 2026-07-10

Fixes inbound chats fragmenting into multiple threads for the same
number.

> **Migration required:** apply `supabase/migrations/036_conversation_contact_dedup.sql`
> (merges any existing duplicate conversations into the oldest thread —
> no messages are lost — then adds a `UNIQUE (account_id, contact_id)`
> index so one contact can only ever have one conversation).

### Fixed

- **Duplicate chats for a single contact.** An inbound message could
  create a second conversation for a contact under a race (Meta retries a
  delivery, or a batch fans out to concurrent runs). Once two existed,
  the `.single()` lookup errored on every later message and the webhook
  created yet another conversation each time, snowballing into a wall of
  duplicate chats. The find-or-create now resolves to the oldest existing
  thread and a DB unique index makes the one-conversation-per-contact
  rule authoritative. The same hardening was applied to the public-API
  conversation resolver. (Issue #363)

## [0.8.0] — 2026-07-08

Polishes the AI auto-reply bot: it's now **visible and controllable from
the inbox**, its **handoff actually hands off**, and its **token spend is
logged**.

> **Migration required:** apply `supabase/migrations/033_ai_reply_polish.sql`
> (adds `messages.ai_generated`, `ai_configs.handoff_agent_id`,
> `conversations.ai_handoff_summary`, and the `ai_usage_log` table).

### Added

- **"AI" badge in the inbox.** Replies the bot sent are tagged with a
  small ✨ AI badge, so agents can tell an automated reply from their own
  or a Flow's at a glance. (New `messages.ai_generated` flag; only the
  auto-reply bot sets it.)
- **Take over / Resume from the thread.** A banner on AI-handled
  conversations lets an agent **Take over** (pauses the bot for that
  thread and assigns it to them) or **Resume AI** (hands the thread back
  and clears the pause). Backed by `POST /api/ai/autoreply/[id]`.
- **Real handoff.** When the bot bails (can't help, or hits the reply
  cap) it now (1) routes the conversation to a configurable **handoff
  target** — a specific agent, or the unassigned queue — and (2) leaves a
  short **internal note** summarizing the exchange for whoever picks it
  up. Assigning fires the existing assignment notification. Pick the
  target under **AI Agents → Setup → Hand off to**.
- **Token-usage logging + dashboard.** Every draft and auto-reply records
  its provider token counts to the new `ai_usage_log` table
  (admin-readable). A new **AI Agents → Usage** tab (admin-only) charts
  daily token spend on your BYO key with per-mode and per-model
  breakdowns, backed by `GET /api/ai/usage`. Counts only — no message
  content is stored or shown.

### Changed

- Auto-reply now has an **account-wide rate limit** (30/min) on top of
  the existing per-conversation cap, so a burst of inbound can't run your
  provider key past its limit. Over the limit, inbounds simply wait in
  the inbox for a human instead of being auto-answered.

## [0.7.0] — 2026-07-02

Promotes the AI assistant to a first-class **AI Agents** section in the
sidebar — it's no longer tucked inside Settings.

### Added

- **AI Agents (sidebar).** A dedicated `/agents` area with two tabs:
  - **Playground** — a test chat to message your agent and see its
    grounded, multi-turn replies (and where it would hand off to a human)
    *before* it ever answers a real customer. Runs the exact same path as
    the auto-reply bot (knowledge-base retrieval + your provider), and
    works even before you flip the master switch on, so you can try, then
    enable. Backed by `POST /api/ai/playground`.
  - **Setup** — the provider/key, business context, knowledge base, and
    auto-reply controls (moved here from Settings → AI Assistant).

### Changed

- The AI configuration moved out of **Settings → AI Assistant** into the
  new **AI Agents** section. No data change — same account config, new
  home. No migration required.

## [0.6.0] — 2026-07-02

Adds an **AI knowledge base** so the assistant (0.5.0) can answer from
your own content instead of handing off. Paste FAQs, policies, or
product details under **Settings → AI Assistant → Knowledge base**; the
relevant excerpts are retrieved into every draft and auto-reply.

### Added

- **Knowledge base with hybrid retrieval.** Lexical Postgres full-text
  search works for every account with no extra credentials. Optional
  **semantic search** (pgvector, OpenAI `text-embedding-3-small`) turns
  on when you add an **embeddings key** — semantic-primary, topped up
  with lexical to fill the result set. Anthropic-only accounts (Anthropic
  has no embeddings API) keep the lexical path with zero extra setup.
- **Knowledge base manager** in Settings — add/edit/delete documents and
  a **Reindex** action to backfill embeddings after adding a key. Both
  drafts and the auto-reply bot are grounded in the retrieved excerpts,
  and the prompt still instructs the model to hand off (auto-reply) or
  say it will follow up (draft) when the KB doesn't cover the question.
  **Migration required:** apply `supabase/migrations/030_ai_knowledge.sql`
  (enables `pgvector`; adds `ai_knowledge_documents` + `ai_knowledge_chunks`
  and an `embeddings_api_key` column on `ai_configs`).

## [0.5.0] — 2026-07-02

Adds the **AI reply assistant** — bring-your-own-key. Each account
pastes its own OpenAI or Anthropic key under **Settings → AI
Assistant**; wacrm calls the provider directly with that key, so
there's no per-seat AI fee and your conversation data never leaves
your own infrastructure for a wacrm-run service. The key is stored
AES-256-GCM-encrypted at rest (same as WhatsApp tokens) and never
returned to the client after saving.

### Added

- **AI-drafted replies in the inbox.** A ✨ button in the composer
  (agent+) reads the recent conversation and drops a suggested reply
  into the box for the agent to edit and send. Read-only server-side —
  `POST /api/ai/draft` never sends or stores anything. Respects your
  business context / persona from the settings prompt.
- **AI auto-reply bot.** When enabled, inbound messages that no
  deterministic Flow consumed and that have no agent assigned get an
  automatic LLM reply. Bounded by a per-conversation cap
  (`auto_reply_max_per_conversation`, default 3) and a clean human
  handoff: when the model can't confidently help — or the customer
  asks for a person — it stays silent and leaves the message for a
  human, and won't auto-reply on that thread again until re-enabled.
  Flows always win over the bot.
- **Settings → AI Assistant** (admin+ to edit): pick provider + model,
  paste your key, add business context/tone, toggle the assistant and
  auto-reply, set the per-conversation cap, and **Test key** against
  the provider before saving.
- Providers: OpenAI (Chat Completions) and Anthropic (Messages) behind
  one interface; model is a free-text field with sensible defaults, so
  you can point it at any current model your key can access.
  **Migration required:** apply
  `supabase/migrations/029_ai_reply.sql` (adds `ai_configs` +
  per-conversation auto-reply columns on `conversations`).

## [0.4.0] — 2026-07-01

Completes the public API (#245): **outbound event webhooks** so
automations can *react* to activity instead of polling.

### Added

- **Outbound event webhooks (`/api/v1/webhooks`).** Register an HTTPS
  endpoint (scope `webhooks:manage`) to be POSTed to when an event
  happens in your account — `message.received`, `message.status_updated`,
  or `conversation.created`. Manage endpoints with
  `GET/POST /api/v1/webhooks` and `GET/PATCH/DELETE /api/v1/webhooks/{id}`.
  Each delivery is signed with an `X-Wacrm-Signature`
  (HMAC-SHA256 over `timestamp.body`) so receivers can verify
  authenticity and reject replays; the signing secret is returned once
  at creation and stored encrypted. Delivery is best-effort — an
  endpoint that fails repeatedly is auto-disabled after a threshold of
  consecutive failures. See `docs/public-api.md`.
  **Migration required:** apply
  `supabase/migrations/028_webhook_endpoints.sql`.
  ([#245](https://github.com/ArnasDon/wacrm/issues/245))

## [0.3.0] — 2026-07-01

Multi-user accounts ship. Every wacrm install is multi-tenant on the
database side: a single user's signup creates a fresh "account", and
every row is scoped to that account rather than to the user directly.
This release also opens the user-visible **Members** surface — invite
teammates by link, manage their roles, transfer ownership — to all
users. The `'account_sharing'` beta gate that hid it during
development is removed (mirrors the Flows soft-GA in 0.2.0). Existing
self-hosted instances keep working: every existing user is backfilled
as the sole owner of their own account and sees identical data, and a
solo owner who never invites anyone sees the same single-user app they
always did.

### Added

- **Public REST API (`/api/v1`) — groundwork.** A scoped, revocable
  **API key** system so you can drive wacrm from your own scripts and
  automations. Create keys under **Settings → API keys** (admin+),
  grant only the scopes each integration needs, and authenticate with
  `Authorization: Bearer <key>`. Keys are account-scoped and stored
  hashed (plaintext shown once). This release ships the auth layer,
  scopes, per-key rate limiting, the management UI, and a
  `GET /api/v1/me` probe to verify a key. See
  `docs/public-api.md`. **Migration required:** apply
  `supabase/migrations/026_api_keys.sql`. ([#245](https://github.com/ArnasDon/wacrm/issues/245))
- **Public REST API — data endpoints.** Built on the key auth above,
  so external automations can read and drive the CRM:
  - `POST /api/v1/messages` — send a text / template / media message to
    a phone number; finds-or-creates the contact + conversation
    (`messages:send`).
  - `GET/POST /api/v1/contacts`, `GET/PATCH /api/v1/contacts/{id}` —
    list (search + tag filter), create (find-or-create by phone), read,
    and update contacts, including tags (`contacts:read` /
    `contacts:write`).
  - `GET /api/v1/conversations`, `GET /api/v1/conversations/{id}`, and
    `GET /api/v1/conversations/{id}/messages` — browse conversations and
    their message history with delivery status (`conversations:read` /
    `messages:read`).
  - `POST /api/v1/broadcasts` + `GET /api/v1/broadcasts/{id}` — launch a
    template broadcast to a recipient list and poll its progress
    (`broadcasts:send`).
  All list endpoints share one cursor-pagination contract
  (`{ data, meta: { next_cursor } }`). No migration required — the
  scopes already existed and the tables are unchanged. Outbound event
  webhooks (react to inbound messages) are the remaining roadmap item.
  See `docs/public-api.md`. ([#245](https://github.com/ArnasDon/wacrm/issues/245))

### Changed

- **Tenancy moves from per-user to per-account.** RLS on every
  domain table (contacts, conversations, messages, broadcasts,
  automations, flows, pipelines, templates, tags, …) now checks
  account membership via a new SECURITY DEFINER helper
  `is_account_member(account_id, min_role)` instead of
  `auth.uid() = user_id`. The `user_id` columns stay on every row
  for assignment / audit but no longer enforce isolation.
- **WhatsApp config is one-per-account, not one-per-user.** The
  `whatsapp_config.UNIQUE(user_id)` constraint is replaced by
  `UNIQUE(account_id)`.
- **`flow_runs` idempotency key swaps to `(account_id, contact_id)`**
  so two accounts sharing a contact phone number can each run their
  own flows independently.
- **The signup trigger (`handle_new_user`) now also creates a
  personal account** and links the new profile to it as `owner`.

### Changed

- **Flow-media storage is now account-scoped.** Migration 016
  pathed uploaded files under `auth.uid()/...`, which orphaned
  flow media when a teammate left a shared account. New uploads
  go under `account-<account_id>/...` and any account member
  with the right role can edit them. Legacy paths remain
  writable by the original uploader for backward compatibility.
- **Webhook contact lookup now pre-filters in SQL.** Previously
  pulled every contact in an account just to JS-filter to one
  row by phone — fine when account = one user, painful when
  account = team. Pre-filter by phone suffix on the database
  side; re-apply `phonesMatch` on the (typically 0-2 row)
  candidate set.

### Migration required

- `supabase/migrations/020_account_sharing_followups.sql` —
  composite partial indexes on `automations(account_id,
  trigger_type) WHERE is_active` and `flows(account_id) WHERE
  status='active'` for the engine dispatch hot path; updated
  `flow-media` storage RLS to allow account-member writes under
  the new path convention. Idempotent.

- **Role-aware UI gating across the app.** The inbox composer's
  send button + textarea, the "New broadcast / automation / flow"
  buttons, the "Add pipeline / deal" buttons, and the "Add /
  Import contact" buttons are now disabled-with-tooltip for
  viewers (and for agents on settings-class actions). Choice:
  show-but-disable rather than hide, so the UI never feels
  silently broken to a teammate looking at a feature they don't
  yet have permission for.
- **Sidebar surfaces the active account** above the user info
  whenever the account name differs from your own — i.e. once
  you've renamed the account or joined a shared one. A default
  solo account is named after you, so the strip stays hidden to
  avoid duplicating your name in the footer.
- **Members is open to all users.** The `account_sharing` beta
  flag that hid the Settings → Members tab and the sidebar
  account strip during development is gone; the multi-user
  surface is now part of the standard app. (Same soft-GA move as
  Flows in 0.2.0.)

### Fixed

- **Inbound WhatsApp messages now land in the shared inbox.** The
  webhook + automations + flows engines used to route inbound
  events by `user_id`, which after the 017 migration only matched
  the WhatsApp config owner's automations / flows — teammates'
  rules never fired. PR 8 of the multi-user series flips every
  lookup to `account_id` so any member of the account sees the
  inbound message and any teammate's automation or flow can react
  to it. Also fixes incipient NOT NULL violations on
  `automation_logs`, `automation_pending_executions`, `flow_runs`,
  and `deals` — those tables gained `account_id NOT NULL` in 017
  but the engines hadn't yet been updated to populate it.

### Added

- **Duplicate phone numbers are now prevented across contacts.** A
  phone number can no longer become more than one contact in the same
  account. Adding a contact whose number already exists is blocked
  with a link to the existing record (and a softer warning for
  near-matches that share their last 8 digits); CSV import de-dupes
  within the file and against existing contacts, reporting
  "X imported, Y duplicates skipped". The rule is enforced by a
  database unique index on the normalized number, so the WhatsApp
  webhook, the form, import, and any future path all agree. Existing
  duplicates are merged into the oldest contact on upgrade (their
  conversations, deals, notes, and tags are re-pointed, nothing is
  lost). Closes #212.
- **Configurable default deal currency.** Each account can now pick
  its default currency under **Settings → Deals** (admin+); the app
  previously hardcoded USD throughout. New deals default to it, and
  pipeline-stage totals, the dashboard "Open Deals Value" card, the
  pipeline-value donut, and automation-created deals all use it.
  Existing deals keep the currency they were saved with — totals are
  shown in the account default with no exchange-rate conversion (one
  currency per account). Full guide:
  [Default currency](https://wacrm.tech/docs/settings#deals).
- **Members tab in Settings.** The user-facing surface for the
  multi-user APIs below, available to everyone (no beta flag). From
  Settings → **Members** an admin or owner can: see who's on the
  account with their role and join date, invite teammates by
  generating a one-time share link (pick the role + optional
  expiry), revoke pending invites, change a member's role, remove a
  member, and — as owner — transfer ownership. Recipients accept via
  a public `/join/[token]` page. Full guide:
  [Members docs](https://wacrm.tech/docs/members).
- **Account & member management API** — server-side endpoints
  backing the Members tab. All routes are role-gated and
  return Supabase-RLS-scoped data.
  - `GET /api/account` — caller's account + role. Any member.
  - `PATCH /api/account` — rename the account. Admin+.
  - `GET /api/account/members` — list members. Email visible to
    admin+ only; agents/viewers see name + avatar + role +
    joined date.
  - `PATCH /api/account/members/[userId]` — change a member's
    role. Admin+. Owner promotion/demotion goes through the
    transfer endpoint instead.
  - `DELETE /api/account/members/[userId]` — remove a member.
    Admin+. The removed user keeps their login and is moved to a
    freshly-created personal account (mirror of the signup flow).
  - `POST /api/account/transfer-ownership` — owner only. Atomic
    swap with the named member.
- **Invitation API + redeem flow** — the no-email, link-only
  invite path that powers the Members tab's "Invite member" button
  and the `/join/[token]` accept page.
  - `GET /api/account/invitations` — list outstanding (admin+).
  - `POST /api/account/invitations` — create an invite, returns
    the plaintext token + share URL **exactly once** (we store
    only the SHA-256 hash on the row). Body
    `{ role, expiresInDays?, label? }`. Admin+.
  - `DELETE /api/account/invitations/[id]` — revoke (admin+).
  - `GET /api/invitations/[token]/peek` — public, per-IP
    rate-limited. Returns `{ ok, account_name, role, expires_at }`
    or `{ ok: false, reason }` so the join page can render
    "You're being invited to <Account> as <Role>".
  - `POST /api/invitations/[token]/redeem` — authenticated.
    Atomically moves the caller's profile to the inviter's
    account and cleans up the orphan personal account. Refuses
    with 409 if the caller's current account already contains
    domain data (no silent data loss).

### Migration required

Apply against your Supabase project before deploying this version:

- `supabase/migrations/017_account_sharing.sql` — introduces the
  `accounts` and `account_invitations` tables plus an
  `account_role_enum` type; adds `account_id` to every
  user-scoped table and backfills it; rewrites every RLS policy;
  replaces the new-user trigger. Idempotent. **No data loss** —
  every existing user is mapped to a freshly-created account
  with role `owner` and every existing row of theirs is linked
  to that account.
- `supabase/migrations/018_account_member_rpcs.sql` — adds three
  `SECURITY DEFINER` RPCs (`set_member_role`,
  `remove_account_member`, `transfer_account_ownership`) that
  back the member-management API. They self-check the caller's
  role and raise SQLSTATE `42501` / `22023` on forbidden / bad
  input so the API layer can map cleanly to 403 / 400.
  Idempotent.
- `supabase/migrations/019_invitation_rpcs.sql` — adds two
  `SECURITY DEFINER` RPCs: `peek_invitation` (anonymous read by
  token hash, returns a fixed-shape JSON envelope) and
  `redeem_invitation` (authenticated atomic move + orphan
  cleanup, with a domain-data safety check). Both bypass the
  RLS that would otherwise block their reads/writes. Idempotent.
- `supabase/migrations/021_account_default_currency.sql` — adds
  `accounts.default_currency` (`TEXT NOT NULL DEFAULT 'USD'`, with a
  3-letter-code `CHECK`) backing the configurable default currency.
  Idempotent; existing accounts backfill to `USD`. **Apply before
  deploying** — the app now reads this column when loading the
  account, so an un-migrated database breaks account loading.
- `supabase/migrations/022_contact_phone_dedup.sql` — adds the
  generated `contacts.phone_normalized` column, **merges existing
  duplicate contacts into the oldest** (re-pointing conversations,
  deals, notes, tags, custom values, and broadcast recipients — no
  data loss), then adds a `UNIQUE (account_id, phone_normalized)`
  index. Idempotent. **Apply before deploying** — CSV import reads
  `phone_normalized`, and the index is what enforces de-duplication
  for every write path. The one-shot merge runs inside the migration.

## [0.2.2] — 2026-05-29

Flow nodes can now send media. Closes the most-requested gap from user
feedback after the v0.2.0 Flows launch — flows were text-only and
couldn't deliver an invoice, receipt, product photo, or short demo
video mid-conversation.

### Added

- **`send_media` flow node.** Send an image (PNG / JPEG / WebP), video
  (MP4 / 3GP), or document (PDF, Word, Excel, PowerPoint, TXT) to the
  customer from any point in a flow. Pick a file in the builder, it
  uploads to the new `flow-media` Supabase Storage bucket, and Meta
  fetches the public URL at send time. Optional caption (1024 char cap,
  supports `{{vars.X}}` interpolation); documents also take an optional
  filename shown in the recipient's chat. Auto-advances after send —
  same suspend semantics as `send_message`.
  ([#156](https://github.com/ArnasDon/wacrm/pull/156))

### Migration required

Apply against your Supabase project before deploying this version:

- `supabase/migrations/016_flow_media.sql` — does two things:
  1. Adds `'send_media'` to the `flow_nodes.node_type` CHECK
     constraint. Without this the `send_media` node fails to save with
     a constraint violation.
  2. Creates the public `flow-media` Supabase Storage bucket (16 MB
     file-size cap, image / video / document MIME allowlist) plus
     per-user RLS policies (path prefix = `auth.uid()`). Without this
     the builder's file picker fails on upload. Same shape as the
     `avatars` bucket from migration 008 — the bucket is **public** so
     Meta can fetch the URL without credentials.

The migration is idempotent and safe to re-run.

## [0.2.1] — 2026-05-26

Bug-fix release. Plugs a silent inbound-message drop that triggered
when two users on the same instance saved the same WhatsApp
`phone_number_id`.

### Fixed

- **Inbound WhatsApp messages no longer silently disappear** when two
  users have claimed the same `phone_number_id`. Previously the
  webhook used `.single()` to look up the owning config, which errors
  `PGRST116` for both 0 rows *and* ≥2 rows — the second user's save
  put the DB into the ≥2-row state and every inbound message was
  dropped while the log misleadingly reported *"No config found for
  phone_number_id"*. Three layers of fix: `POST /api/whatsapp/config`
  now returns **409** when another user has already claimed the
  number, the webhook lookup distinguishes 0 rows from ≥2 rows and
  logs the conflicting `user_id`s, and a new DB constraint
  (`UNIQUE(phone_number_id)`) prevents the bad state at the storage
  layer. Reported in
  [#136](https://github.com/ArnasDon/wacrm/issues/136), fixed in
  [#143](https://github.com/ArnasDon/wacrm/pull/143).

### Migration required

Apply against your Supabase project before deploying this version:

- `supabase/migrations/013_whatsapp_config_phone_number_id_unique.sql`
  — adds `UNIQUE(phone_number_id)` to `whatsapp_config`. **Fails
  loudly with a copy-pasteable resolution hint** if duplicate rows
  already exist; auto-deduping would destroy encrypted tokens, so
  the operator picks which row keeps the number. To check first:

  ```sql
  SELECT phone_number_id, array_agg(user_id) AS owners, count(*) AS n
  FROM whatsapp_config
  GROUP BY phone_number_id
  HAVING count(*) > 1;
  ```

  If that returns rows, `DELETE` the duplicate row(s) you want to
  drop, then re-run the migration.

### Note on multi-user setups

wacrm is intentionally **single-tenant per WhatsApp number**. RLS on
`conversations`/`messages` is `auth.uid() = user_id`, so a second
user physically cannot read messages routed to a different owner —
two users sharing one number was never supported. If you need
multiple humans handling the same inbox, run them under one shared
account.

## [0.2.0] — 2026-05-22

The **Flows** release. Adds a no-code, branching, button-driven WhatsApp
conversation engine that runs alongside Automations. Also ships a
5-theme color picker in Settings and opens Flows to all users.

### Added

#### Flows — branching chatbot conversations

- **Module + schema.** New `flows`, `flow_nodes`, `flow_runs`,
  `flow_run_events` tables with partial unique indexes that enforce
  one active run per contact. Widened `messages.content_type` CHECK
  to accept `'interactive'`; added `interactive_reply_id` column so
  the inbox can render button/list taps.
  ([#112](https://github.com/ArnasDon/wacrm/pull/112))
- **Runner engine.** `dispatchInboundToFlows` parses every inbound
  webhook, decides whether the message is a reply on an active run
  or a fresh trigger, advances the state machine, and reports back
  to the webhook so consumed messages don't also fire automations.
  Idempotent on Meta's `message_id`.
  ([#114](https://github.com/ArnasDon/wacrm/pull/114))
- **No-code builder UI** at `/flows`. Linear-list editor with
  per-node config forms, live validator, draft/active/archived
  status, and a 5-route REST API (`GET/POST /api/flows`,
  `GET/PUT/DELETE /api/flows/[id]`, `POST /api/flows/[id]/activate`,
  `GET /api/flows/[id]/runs`, `GET /api/flows/templates`).
  ([#115](https://github.com/ArnasDon/wacrm/pull/115))
- **Templates + v1.5 node types.** Three starter templates
  (Welcome menu, FAQ bot, Lead capture) cloneable from the New-flow
  dialog. Three new node types: `collect_input` (capture customer
  text into a variable), `condition` (branch on var / tag / contact
  field), `set_tag` (add or remove a tag). `{{vars.X}}` interpolation
  in send_message + collect_input prompts. Per-flow run-history
  viewer at `/flows/[id]/runs`.
  ([#117](https://github.com/ArnasDon/wacrm/pull/117))
- **Stale-run sweep cron** at `GET /api/flows/cron` — marks runs
  past their configured timeout (default 24h) as `timed_out` so
  abandoned conversations free up the contact for new triggers.
  Reuses `AUTOMATION_CRON_SECRET`.
  ([#114](https://github.com/ArnasDon/wacrm/pull/114))

#### Color themes

- **5 color themes** (Violet default, Emerald, Cobalt, Amber, Rose)
  selectable from a new **Appearance** tab in Settings. CSS variables
  scoped under `html[data-theme="..."]`, applied at runtime via
  `dataset.theme`, persisted to `localStorage`. Inline boot script in
  `layout.tsx` replays the choice before first paint so there's no
  flash of the default.
  ([#132](https://github.com/ArnasDon/wacrm/pull/132))
- **Theme tokenization sweep** — every previously hard-coded
  `violet-*` Tailwind class replaced with `primary` tokens across
  ~49 files. Picking a non-violet theme now themes the whole app,
  not just the chrome.
  ([#133](https://github.com/ArnasDon/wacrm/pull/133))

### Changed

#### Flows — soft-GA

- **Flows is now available to every authenticated user.** The
  per-account beta gate is gone; the sidebar entry + page header
  carry a small "Beta" chip as the only remaining signal.
  ([#134](https://github.com/ArnasDon/wacrm/pull/134))
- **Editor UX**:
  - Internal `node_key` + per-button/row `reply_id` identifiers
    hidden behind a per-node "Show advanced" disclosure.
    ([#118](https://github.com/ArnasDon/wacrm/pull/118))
  - `send_list` nodes can have multiple sections.
    ([#119](https://github.com/ArnasDon/wacrm/pull/119))
  - Collapsed node cards show a 1-line content preview per node
    type (text excerpt, button titles, condition summary, etc.).
    ([#120](https://github.com/ArnasDon/wacrm/pull/120))
  - Validation issues are clickable: jump to + flash the offending
    node.
    ([#121](https://github.com/ArnasDon/wacrm/pull/121))
  - Unsaved-changes "● Edited" indicator + `beforeunload` reload
    guard.
    ([#122](https://github.com/ArnasDon/wacrm/pull/122))
  - New-flow dialog actually widens to fit the 3 template cards
    (was capped at 384px by a baked-in `sm:max-w-sm` from shadcn).
    ([#129](https://github.com/ArnasDon/wacrm/pull/129),
    [#131](https://github.com/ArnasDon/wacrm/pull/131))
  - Validation panel pinned to the viewport bottom so
    activate-readiness follows the user as they scroll through nodes.
    ([#130](https://github.com/ArnasDon/wacrm/pull/130))

#### Engine reliability

- **Atomic `execution_count` increment** via SECURITY DEFINER RPC —
  prevents lost counts when two webhooks start runs concurrently.
  Mirrors the automations engine pattern.
  ([#124](https://github.com/ArnasDon/wacrm/pull/124))
- **Preload all flow_nodes once per dispatch** — one SELECT per
  inbound instead of one per advance-loop iteration. A 5-node
  auto-advance chain now costs 1 round trip, not 5.
  ([#125](https://github.com/ArnasDon/wacrm/pull/125))
- **Wasted re-read dropped** after reprompt reset; `loadActiveRun`
  switched to defensive `.limit(1)` so a migration glitch producing
  duplicates can't crash dispatch.
  ([#126](https://github.com/ArnasDon/wacrm/pull/126))

### Security

- **PII redacted from `reply_received` event payload** — customer
  text is no longer persisted to `flow_run_events.payload`; only
  the length is. A `collect_input` prompt asking "what's your card
  number?" used to leave the PAN sitting in the events table.
  ([#123](https://github.com/ArnasDon/wacrm/pull/123))
- **Constant-time cron-secret compare** on `/api/flows/cron`
  (`crypto.timingSafeEqual`) to close a theoretical
  timing-side-channel on the `x-cron-secret` header check.
  ([#127](https://github.com/ArnasDon/wacrm/pull/127))

### Fixed

- **`/flows` no longer spuriously redirects to `/dashboard`** when
  navigating in. Root cause: `useAuth` flipped `loading: false`
  before the profile fetch resolved. `use-auth` now exposes a
  separate `profileLoading` boolean.
  ([#128](https://github.com/ArnasDon/wacrm/pull/128))

### Migration required

Apply, in order, against your Supabase project:

1. `supabase/migrations/010_flows.sql` — Flows core tables, indexes,
   RLS policies, and the `messages` schema widening.
2. `supabase/migrations/011_profile_beta_features.sql` — adds the
   `profiles.beta_features` column. Surviving for future betas;
   Flows no longer reads it.
3. `supabase/migrations/012_flows_increment_counter.sql` — atomic
   counter RPC. Without this the engine still runs but
   `flows.execution_count` is racy.

Each migration is idempotent — safe to re-run if you're not sure
whether you applied a previous one.

### Removed

- **`src/lib/flows/feature-flag.ts`** + its tests. Flows is open to
  all users; the `profiles.beta_features` column itself survives
  for future beta gates.
  ([#134](https://github.com/ArnasDon/wacrm/pull/134))

---

## [0.1.1] — 2026-05-19

### Added

- Chat actions in the inbox: emoji reactions, reply-with-quote, and
  copy-text on individual messages. Hover on desktop, long-press on
  touch. Outbound reactions and replies forward to WhatsApp via the
  Cloud API; inbound reactions and swipe-replies from customers
  arrive through the webhook and appear in real time.

### Migration required

- Apply `supabase/migrations/009_message_actions.sql` to your
  Supabase project. It adds `messages.reply_to_message_id` and the
  new `message_reactions` table (with RLS and realtime). The
  migration is idempotent — safe to re-run.

### Changed

- The webhook no longer stores inbound customer reactions as fake
  text messages. They are written to `message_reactions` instead,
  so any custom queries that counted reactions as messages will
  need updating.

---

## [0.1.0]

Initial template release. Core CRM: inbox, contacts, pipelines,
broadcasts, automations (with a Wait-step cron drain), WhatsApp
Cloud API integration, Supabase auth + RLS.
