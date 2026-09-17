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
arriving silently. Point a scheduled pinger (the same one driving
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

## How replies are threaded

The first message the CRM sends to a contact who hasn't emailed in yet
is a plain new email (`sendMail`). Every reply after that — from the
dashboard composer or an automation's `send_message` step — uses
Graph's `reply` action on the customer's most recent inbound message,
so it lands in the customer's own mail client as a normal threaded
reply, not a disconnected new email each time.

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
