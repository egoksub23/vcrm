# Gmail setup

The Gmail channel connects one Gmail mailbox to your CRM, through a
real "Connect Gmail" OAuth flow from Settings → Channels — the same
pattern as every other channel's connect button.

Gmail is kept as a separate channel from
[Microsoft 365 / Outlook](./microsoft-365-email-setup.md) even though
both are "email" — you can run one, the other, or both (e.g. `sales@`
on Gmail and `support@` on Microsoft 365), the same way Messenger and
Instagram stay separate despite both being Meta.

Unlike every other channel here, **sending and receiving are two
separate pieces of setup**: sending works as soon as you complete step
2 below. Receiving needs step 3 too — a one-time Google Cloud Pub/Sub
setup this app can't create on your behalf, because it needs
project-level GCP permissions no single Gmail OAuth token can grant.
Don't skip it if you need inbound mail.

## 1. Create a Google Cloud project (if you don't have one)

In the [Google Cloud Console](https://console.cloud.google.com), create
a new project (or reuse an existing one) — **Enabled APIs & Services**
→ **Enable APIs and Services** → search **Gmail API** → **Enable**.

## 2. OAuth credentials (required — this is what makes sending work)

**APIs & Services → OAuth consent screen**: set it up if you haven't
already (External user type is fine for a single-workspace CRM; you
don't need Google's verification review unless you plan to let
unrelated third parties connect their own Gmail through your app —
your own account can always connect as a "test user").

**APIs & Services → Credentials → Create Credentials → OAuth client
ID**:

- **Application type**: Web application
- **Authorized redirect URIs**:
  ```
  https://your-domain.com/api/account/channels/gmail/oauth/callback
  ```
  This must exactly match `NEXT_PUBLIC_SITE_URL` (see
  `.env.local.example`) — set that env var explicitly, since a
  mismatch here is the most common OAuth failure across every channel
  in this app.

Copy the **Client ID** and **Client secret** into your environment:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

At this point, **Settings → Channels → Gmail → Connect Gmail** will
work, and sending replies through a connected mailbox works
immediately. Inbound messages won't arrive yet — that's step 3.

## 3. Pub/Sub setup (required for inbound messages)

Gmail has no self-service "give me a webhook URL" flow the way
Microsoft Graph or a plain REST webhook does — instead, Gmail publishes
change notifications to a Google Cloud Pub/Sub **topic**, and you
attach a **push subscription** to that topic pointing at this app.

**Pub/Sub API**: **APIs & Services** → enable **Cloud Pub/Sub API** if
not already enabled.

**Create the topic**: **Pub/Sub → Topics → Create Topic**. Any name,
e.g. `gmail-notify`. Note its full resource name:
```
projects/<your-project-id>/topics/gmail-notify
```
Set this as `GMAIL_PUBSUB_TOPIC` in your environment.

**Grant Gmail permission to publish to it**: still on the topic →
**Permissions** → **Add Principal**:
- Principal: `gmail-api-push@system.gserviceaccount.com`
- Role: **Pub/Sub Publisher**

This is Google's own fixed service account for Gmail's push feature —
not something specific to your project.

**Create the push subscription**: **Pub/Sub → Subscriptions → Create
Subscription**, attached to the topic above:
- **Delivery type**: Push
- **Endpoint URL**: the exact URL shown in Settings → Channels → Gmail
  → Push notification setup, once you've connected in step 2. It looks
  like:
  ```
  https://your-domain.com/api/gmail/webhook?token=<per-connection-secret>
  ```
  That token is generated per-account when you connect and is this
  webhook's only authentication — Pub/Sub carries no signature the way
  Meta or Microsoft Graph webhooks do, so copy it exactly.

## 4. Reconnect to register the watch

If you connected Gmail (step 2) **before** finishing step 3, reconnect
once from Settings → Channels → Gmail — the connect flow registers
Gmail's push-notification watch against `GMAIL_PUBSUB_TOPIC` at connect
time, so it needs that env var to already be set.

## 5. Keep the watch alive

A Gmail watch registration expires after at most 7 days and must be
renewed, or inbound mail stops arriving silently. Point a scheduled
pinger (the same one driving `/api/automations/cron` and
`/api/email/subscription-renew`, if you already use those) at:

```
GET https://your-domain.com/api/gmail/watch-renew
Header: x-cron-secret: <AUTOMATION_CRON_SECRET>
```

**At least once a day.** It renews anything expiring within the next
48 hours, so a daily hit leaves ample slack. See
`docs/automations-and-cron.md` for pinger options — same guidance,
just a third URL to hit alongside the other two.

## How replies are threaded

Same behavior as the Microsoft 365 channel: the first message to a
contact who hasn't emailed in yet is a plain new email. Every reply
after that threads onto the customer's own Gmail conversation — both
via Gmail's own `threadId` (so it groups correctly in Gmail's UI) and
proper `In-Reply-To`/`References` headers (so it threads correctly in
any other mail client too).

## What's not supported yet

- **Attachments over ~3 MB.** Gmail's inline attachment fetch (used
  here) is fine for typical attachments; very large files aren't
  handled specially in this version.
- **Templates and interactive buttons/lists** — WhatsApp-only, same as
  every other non-WhatsApp channel.
- **Delta reconciliation beyond Gmail's own history retention.** If a
  Pub/Sub notification is missed for long enough that
  `users.history.list` 404s (Gmail's history log has limited
  retention, roughly a week), this app re-baselines from the mailbox's
  current historyId and accepts the gap rather than reconstructing it.
