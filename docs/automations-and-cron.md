# Scheduled jobs (cron)

Nothing inside the Halo container is scheduled. Several features only work
if something outside it calls a URL on a timer. This page lists every job,
how often to call it, and how to tell that it is actually running.

## How a job is called

Every job is a `GET` with the shared secret in a header:

```bash
curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/automations/cron
```

- `AUTOMATION_CRON_SECRET` must be set on the server (see `.env.local.example`).
  Without it every job answers **503**. A missing or wrong header answers **401**.
- The secret is compared in constant time (`src/lib/cron/guard.ts`, the one
  place that does the check for all jobs).
- Any scheduler works: the server's crontab, Vercel Cron, GitHub Actions, an
  uptime pinger. On the VPS it is the host crontab.

## The jobs

| Endpoint | What it does | Call it | Without it |
|---|---|---|---|
| `/api/automations/cron` | Runs the delayed ("Wait") steps of automations that have come due. | every 5 min | Wait steps never resume. |
| `/api/flows/cron` | Times out flow runs a customer abandoned (default 24 h). | hourly | Abandoned runs block new flow triggers for that customer forever. |
| `/api/sla/cron` | Notifies when a conversation has waited longer than its workspace's response-time target. | every 5 min | No "response time exceeded" alerts. |
| `/api/sla/tickets-cron` | Marks ticket SLA breaches and sends at-risk and breached notices. | every minute | Ticket SLA state is shown live but never stored or notified. |
| `/api/incidents/escalation-cron` | Escalates unacknowledged incidents up the levels. | every minute | Incidents never auto-escalate. |
| `/api/sign/jobs-cron` | Secure Sign: seals documents everyone has signed, expires documents past their date, sends due reminders. | every minute | Signed documents stay in "Finishing", and no reminders or expiries happen. See `docs/doc-sign-setup.md`. |
| `/api/integrations/jira/cron` | Jira job queue, catch-up poll, webhook renewal. | every 1 to 2 min | Jira links stop syncing. |
| `/api/messages/sweep-cron` | Marks a send stuck in "sending" as failed after 10 min so it can be resent. | every 5 min | A crashed send stays "sending" forever. |
| `/api/email/subscription-renew` | Renews each Microsoft 365 mailbox's change-notification subscription. | daily | Inbound mail stops after about 3 days. |
| `/api/gmail/watch-renew` | Renews each Gmail push registration. | daily | Inbound Gmail stops after about 7 days. |
| `/api/platform/deletion-cron` | Deletes workspaces whose 30-day deletion request has fallen due, and finishes any that stopped half way. | hourly | A requested deletion never happens. |
| `/api/usage/snapshot-cron` | Records each workspace's contacts, members, messages, stored files and AI tokens for the day. | daily | The operator console shows no usage against plan limits. Limits themselves are still enforced live. |

Example crontab (replace `YOUR-APP`):

```cron
* * * * *   curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/sla/tickets-cron
* * * * *   curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/incidents/escalation-cron
* * * * *   curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/sign/jobs-cron
*/2 * * * * curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/integrations/jira/cron
*/5 * * * * curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/automations/cron
*/5 * * * * curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/sla/cron
*/5 * * * * curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/messages/sweep-cron
0 * * * *   curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/flows/cron
15 3 * * *  curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/email/subscription-renew
20 3 * * *  curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/gmail/watch-renew
25 3 * * *  curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/usage/snapshot-cron
30 * * * *  curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/platform/deletion-cron
```

`crontab` does not read your shell profile: write the secret into the line or
set `AUTOMATION_CRON_SECRET=...` at the top of the crontab file.

## Checking that they run

Each job records a heartbeat every time it is called. Sign in as a platform
operator and open **Platform**: the **Background jobs** card lists every job
with the time of the last run.

- **On time**: ran within three expected intervals.
- **Late**: has not reported for three intervals. The usual cause is a missing
  or broken crontab line.
- **Failed**: the last run returned an error. The server log has the reason
  (`[cron <job>] failed:`).
- **Not running**: it has never reported on this deployment.

## Behaviour with many workspaces

These guarantees apply to a deployment with several customers (migration 135):

- **Fair.** Jobs that pick work from a queue (delayed automation steps,
  conversation and ticket SLA, incident escalation, Jira) take a few items from
  each workspace in turn, so one workspace with a large backlog cannot keep the
  others waiting.
- **Suspended workspaces are skipped.** A workspace the operator has suspended
  gets no automation steps, no SLA notices, no escalations, no Jira work, no
  mailbox renewals and no AI replies. Resuming it picks the work up again.
- **Safe to overlap and to crash.** A delayed automation step is claimed with a
  10-minute lease. If the server dies mid-step, the step is marked **failed**
  after the lease (not run a second time: its earlier actions may already have
  reached the customer) and the automation log records why.
- **Bounded.** Each run stops starting new work after about 45 seconds and
  hands unstarted work back, so a slow run cannot overlap the next one for long.
  The flow sweep reads a page at a time and reports `truncated: true` if it ran
  out of time; the next run continues.

## Secure Sign in automations

Secure Sign can start an automation and an automation can send a document. There is one trigger and one step. Both
need Secure Sign switched on for the workspace (the operator flag `sign`, see `docs/doc-sign-setup.md`); the Add
step menu and the trigger list only offer them to people who can see Secure Sign (`menu.sign`).

### The trigger: Secure Sign event (`sign_document_event`)

Fires when a document is **sent, viewed, completed, declined, expired or voided**. Configuration:

| Field | Meaning |
|---|---|
| `events` | The events that fire it. Empty or missing means **completed only**. |
| `template_id` | Only documents made from this template (any when empty). |
| `category_id` | Only documents in this category (any when empty). |

`viewed` fires once per signer, the first time they open their link. The automation runs for the document's
contact (`contact_id`); a document with no contact still fires it, and steps that need a contact (adding a tag,
sending a message) then fail in the run log like they would for any contact-less trigger.

What later steps can read:

| Variable | Value |
|---|---|
| `{{ sign.document_id }}` | The document's id. |
| `{{ sign.reference }}` | Its reference, for example `SGN-2026-000123`. |
| `{{ sign.title }}` | Its title. |
| `{{ sign.status }}` | Its status after the change (`sent`, `completed`, ...). |
| `{{ sign.event }}` | Which event fired it. |
| `{{ sign.template }}` | The template's name (empty if it was not made from one). |
| `{{ sign.final_sha256 }}` | The fingerprint of the signed file (completed only). |
| `{{ sign.certificate_sha256 }}` | The fingerprint of the certificate when it is a file of its own (completed only; empty for a document sealed before certificates became separate files). |
| `{{ sign.verify_url }}` | The public page that proves the signed file is genuine (completed only). |

`{{ contact.name }}`, `{{ contact.first_name }}`, `{{ contact.email }}`, `{{ contact.phone }}` and
`{{ contact.company }}` now work in **every** step that takes text (Send message, Update contact field, Create
deal, Send webhook, Create ticket), not only in AI steps. They used to come out empty in Send message.

The trigger cannot be fired by hand through `POST /api/automations/engine`: only Secure Sign fires it, with the
document's real details.

### The step: Send document for signing (`send_sign_document`)

Makes a draft from a template for the triggering contact, fills it in, puts the people on it and sends it. It
reuses the same services a person's screens use (`createDraftFromTemplate`, `updateDraft`, `setSigners`,
`sendDocument`), so the monthly limit, the readiness checks, the audit trail and the invitations are the same.

| Field | Meaning |
|---|---|
| `template_id` | An **active** template with a saved version. |
| `title` | Optional; supports variables. Empty = the template's title. |
| `recipients` | Each: `role_key`, `source` (`contact` or `fixed`), `channel` (`email` or `whatsapp`), and for `fixed` the `full_name`, `email`, `phone` (variables allowed). Every role the template cannot be sent without needs a person. |
| `merge_values` | `{ "field": "value" }` for the template's merge fields; values may use `{{ contact.* }}`, `{{ vars.* }}` and `{{ sign.* }}`. |
| `send` | Default on. Off leaves a draft for a person to check and send. |
| `message`, `locale` | Optional message to the signers, and the document language. |

After it runs, `{{ vars.sign_document_id }}` and `{{ vars.sign_reference }}` hold the document it made.
The document is linked to the contact and is "created by" the person who owns the automation.

Behaviour worth knowing:

- **Secure Sign says no, the run goes on.** A limit reached, a document that is not ready, a recipient with no
  valid email, a template that is no longer active: the step is logged as **skipped** with the reason, and the
  next steps run. If the document had already been made, it stays as a complete draft linked to the contact so
  a person can fix the cause and send it. A draft that could never be valid (a role the template lacks, a bad
  merge value) is removed again. Only an unexpected failure (a bug, the database down) fails the run.
- **Who may build it.** Saving an automation with this step, or switching one on, needs `sign.send` as well as 
  `automations.manage` (checked on the server in `POST /api/automations` and `PATCH /api/automations/{id}`): it sends 
  documents in the workspace's name. Switching one off needs only `automations.manage`.
- **A contact needs an email address.** Secure Sign requires an email for every signer, even when the link goes by
  WhatsApp. A contact without one is skipped with that message; use a fixed recipient instead.
- **No second document on a retry.** The step remembers the document in `vars.sign_document_id` (with the
  contact and template). If the same run reaches the step again, it reuses that document: a sent one is left
  alone, a draft is sent. Two different runs (the tag added twice) are two documents; delete or void as needed.
- **Activation checks.** Activating (or keeping active) an automation with this step, or with the trigger, is
  refused with a clear message when Secure Sign is off for the workspace, the template is missing or not active, a
  recipient names a role the template does not have, or a required role has no recipient
  (`signSetupForActivation` in `src/lib/automations/sign-activation.ts`, on the server). Drafts save freely.

### Loops

An automation started by a Secure Sign event can itself send a document, which is another event. The depth is
carried in `vars._sign_chain_depth` (the same idea as the tag chain) and the trigger stops being dispatched
after **3** links. The outbound webhook is not affected.

### Outbound webhooks

The same events also go to the workspace's webhook endpoints as `sign.sent`, `sign.viewed`, `sign.completed`,
`sign.declined`, `sign.expired` and `sign.voided` (see `docs/public-api.md`, "Webhooks"). One emitter,
`src/lib/sign/service/outbound.ts`, feeds both, from six places: `sendDocument`, `markViewed`, `sealDocument`,
`declineSigning`, `runExpiry`, `voidDocument`. It runs after the change is committed, after the response where
there is one, and never throws: a broken endpoint or automation cannot undo a signature. A workspace without Doc
Sign never emits. The payload holds ids, dates, status, and each signer's name, role, status and signing time.
**Never an email address, phone number, link token, file address, decline reason or merge value.**

Webhook delivery is the existing single attempt with a 5 second timeout, and an endpoint is switched off after
15 failures in a row. It is **not** retried: a receiver that is down misses the event, so reconcile with the
Secure Sign API when it matters.

### Recipes

Two ready-made automations (Automations > the cards at the top, shown where Secure Sign is on):

1. **Merchant onboarding**: trigger *Tag added*, then *Send document for signing* with the contact as the
   `merchant`. The builder picks the tag named "Merchant applicant" and the template named "Merchant
   Application" when the workspace has them; otherwise it shows the suggestion.
2. **Merchant signed follow-up**: trigger *Secure Sign event* (completed), then *Add tag* "Merchant signed",
   *Create ticket* "Merchant KYC review" (always opened, not skipped when a ticket is open) and a thank-you
   *Send message* (last, because it needs an existing conversation with the contact).

The recipe system was extended minimally for this: a seed's trigger or step configuration may carry
`tag_hint` or `template_hint`, a name the builder looks for and picks. The engine and the validators ignore it.

## Adding a job

Wrap the route with `cronRoute(name, expectedSeconds, handler)` from
`src/lib/cron/guard.ts` and add the name and interval to `CRON_INTERVALS`
there. That gives it the secret check, the heartbeat, a generic 500 on failure,
and a row in the console. Add a translation for its label under `Platform.job_<name>`.
