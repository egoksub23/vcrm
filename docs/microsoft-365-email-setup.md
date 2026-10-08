# Microsoft 365 / Outlook email setup

The Email channel connects one Microsoft 365, Outlook.com, or
Exchange Online mailbox to your CRM via Microsoft Graph, through a real
"Connect Microsoft 365" OAuth flow from Settings → Channels — the same
pattern as Messenger/Instagram's "Connect with Facebook", adapted for
Microsoft's identity platform.

Unlike WhatsApp's manually-registered webhook URL, the inbound
notification subscription is created automatically by the connect flow
itself — there's no separate dashboard step to register a webhook URL
by hand.

A connected mailbox does two jobs, and each has its own switch in
Settings → Channels → Email (migration 179):

| Control | What it does |
|---|---|
| **Customer care inbox** (`inbox_enabled`) | On: customers' emails come into the Halo Inbox and agents reply from there. Off: nothing new comes in, the Inbox does not offer email replies, emails already in the Inbox stay as history. |
| **Send Halo emails from this mailbox** | Not a switch: a status line. Halo's own emails (Secure Sign, team invitations, notifications) go out from the mailbox whenever it is connected, does not need reconnecting, and is not paused, **whatever the inbox switch says**. |
| **Pause this mailbox completely** (`enabled`) | The master switch: nothing in, nothing out. The token is kept. |

So support@ can stay connected as Halo's official sender with its inbox
switched off. The inbox switch is the owner-facing "do I want customer
mail in Halo"; the pause is "stop this mailbox altogether".

## 1. Register an Azure AD app

In the [Azure Portal](https://portal.azure.com) → **Microsoft Entra ID**
→ **App registrations** → **New registration**:

- **Name**: anything recognizable, e.g. "Vircle CRM".
- **Supported account types**: "Accounts in any organizational directory
  and personal Microsoft accounts" (matches this app's default
  `MS365_TENANT_ID=common`) unless your organization requires
  restricting sign-in to a single tenant.
- **Redirect URI**: platform **Web**, value:
  ```
  https://your-domain.com/api/account/channels/email/oauth/callback
  ```
  This must exactly match `NEXT_PUBLIC_SITE_URL` (see
  `.env.local.example`) — set that env var explicitly rather than
  relying on request-header guessing, since a mismatch here is the most
  common OAuth failure (same rule as the Messenger/Instagram setup).

## 2. Add API permissions

**API permissions** → **Add a permission** → **Microsoft Graph** →
**Delegated permissions** — add:

- `Mail.Read`
- `Mail.Send`
- `User.Read`
- `offline_access` (this is what lets the connection stay alive without
  the admin re-approving every hour — Graph access tokens expire in
  about 60 minutes, and this scope is what earns a refresh token)

Personal Microsoft accounts and most individual work/school accounts
can consent to these without an admin. If your organization restricts
app consent, a tenant admin will need to grant consent once (**Grant
admin consent** button on this same page).

## 3. Create a client secret

**Certificates & secrets** → **New client secret**. Copy the secret
**value** immediately — Azure only shows it once.

## 4. Set the environment variables

```
MS365_CLIENT_ID=<Application (client) ID from the Overview page>
MS365_CLIENT_SECRET=<the client secret value from step 3>
```

Leave `MS365_TENANT_ID` unset unless your organization requires
restricting sign-in to a single tenant (see step 1).

## 5. Connect from the app

Settings → Channels → Email → **Connect Microsoft 365**. Sign in and
approve the consent screen for the mailbox you want the CRM to send and
receive from. That's it — no webhook URL to paste anywhere; the connect
flow creates the Graph subscription for you.

## 6. Keep the subscription alive

Microsoft Graph mail subscriptions expire on their own after at most
~2.94 days — they must be renewed before then or inbound email stops
arriving silently. (A mailbox whose **Customer care inbox** is off has no
subscription on purpose: the renewal job and the Inbox's keep-alive ping skip
it without an error, and it is never reported as a problem.) Point a scheduled pinger (the same one driving
`/api/automations/cron` for Wait steps, if you already use those) at:

```
GET https://your-domain.com/api/email/subscription-renew
Header: x-cron-secret: <AUTOMATION_CRON_SECRET>
```

**At least once a day.** It renews any subscription expiring within the
next 24 hours (and self-heals by creating a fresh one if a renewal was
missed for long enough that Graph deleted the old subscription outright),
so a daily or more frequent hit is enough slack. See
`docs/automations-and-cron.md` for pinger options (Vercel Cron,
`cron-job.org`, a VPS crontab, etc.) — the same guidance applies here,
just a second URL to hit.

## Switching the Customer care inbox off and on

- **Off.** The flag is saved first, so the webhook drops anything still in flight.
  Then Halo deletes the Graph change-notification subscription
  (`DELETE /subscriptions/{id}`) and clears `subscription_id`,
  `subscription_expires_at` and `subscription_notification_url`. If Graph cannot
  be reached or the token is dead, the inbox is still off (the webhook ignores
  the notifications) and the subscription lapses by itself within about 3 days;
  the screen says so. Nothing already in the Inbox is touched.
- **On.** The mailbox must be connected and not need reconnecting. Halo creates a
  new subscription with the same code the renewal job uses, then saves the flag.
  Graph notifies about mail that arrives **after** the subscription exists, so
  nothing received while the inbox was off is imported. The screen says so.
- **Reconnecting** (signing in again after the access expired) keeps the choice:
  a mailbox with its inbox off gets no subscription from the reconnect.
- The Inbox does not offer email as a channel to reply on, and the server refuses
  to send an Inbox email reply or new mail (`email_inbox_off`, HTTP 400) while the
  inbox is off. The same goes for automations and the AI.
- Both switches are audited (Settings → Audit: Email, `enabled`, `customer care
  inbox`).

## How replies are threaded

The first message the CRM sends to a contact who hasn't emailed in yet
is a plain new email (`sendMail`). Every reply after that — from the
dashboard composer or an automation's `send_message` step — uses
Graph's `reply` action on the customer's most recent inbound message,
so it lands in the customer's own mail client as a normal threaded
reply, not a disconnected new email each time.

## Halo's own emails send through this mailbox

Every email Halo sends **as the workspace** goes through one shared sender (`src/lib/email/workspace-mail.ts`): the connected mailbox first (Microsoft 365, then
Gmail), then the platform's Resend sender, then nothing. That covers Secure Sign's invitations, reminders, codes and signed copies, team invitations, incident
notifications, the web widget's verification codes and its "you have a new reply" notice. Platform-level mail with no workspace behind it (the operator's
"your workspace is ready" email) stays on Resend. A paused or reconnect-needing mailbox is skipped and the platform sender is used when it is set up.
The mailbox needs `Mail.Send` (reconnect a mailbox connected before that permission was asked for). Every message carries `X-Halo-System: 1` (and Secure
Sign's also `X-Halo-Sign: 1`), keeps no copy in Sent Items, and the change-notification webhook above refuses any message that carries either mark (or quotes
one, as a delivery-failure notice does), so none of it becomes an inbox conversation. Exchange Online limits apply (about 30 messages a minute and 10,000 recipients a day per mailbox); Secure Sign spaces its sends and reports
a throttled message with its reason. Files go inline in the one `sendMail` call, so up to 2.5 MB of signed files are attached and anything larger is replaced
by a link; a draft with an upload session (large attachments) is not built. See `docs/doc-sign-setup.md` sections 1, 9b and 9c.

## What's not supported yet

- **Attachments over ~3 MB.** Graph's inline attachment upload (used
  here) caps out there; larger files need Graph's chunked upload-session
  API, deferred to a later release.
- **Templates and interactive buttons/lists** (automation
  `send_template`, `send_buttons`, `send_list` steps) are WhatsApp-only,
  same as every other non-WhatsApp channel — email has no equivalent
  concept. Plain text and a single attachment (`send_message`) work from
  both the composer and automations.
- **Delta-query reconciliation.** Delivery relies on Graph's change
  notifications only; a notification Microsoft fails to deliver (rare,
  but documented as possible under sustained outages) has no automatic
  backfill in this version.
