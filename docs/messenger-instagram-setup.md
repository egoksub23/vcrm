# Messenger & Instagram DM setup

Facebook Messenger and Instagram DM run on the same Meta Graph API family
WhatsApp does, and reuse the **same Meta App** you already created for
WhatsApp (`META_APP_ID`/`META_APP_SECRET`) — there's no second app to
create. Unlike WhatsApp's manual token entry, connecting either channel
is a real "Connect with Facebook" OAuth flow from Settings → Channels.

## 1. Add the products to your Meta App

In [Meta for Developers](https://developers.facebook.com/apps), open your
existing app (the same one WhatsApp uses) and add:

- **Messenger** product
- **Instagram** product (for Instagram DM — requires a Facebook Page with
  a linked Instagram **professional** account; personal Instagram accounts
  can't receive API messages)

Under **Facebook Login for Business** settings, add these permission
scopes: `pages_show_list`, `pages_messaging`, `pages_read_engagement`,
`business_management`, `instagram_basic`, `instagram_manage_messages`.

## 2. Add your domain to App Domains

**App Settings → Basic → App Domains** — add the bare domain (no
`https://`, no path):

```
your-domain.com
```

This is a separate field from the redirect URIs below, and Meta's error
for missing it ("Can't load URL — the domain of this URL isn't included
in the app's domains") doesn't mention *which* setting to fix, so it's
easy to do step 3 and skip this one. Do both.

## 3. Register the OAuth redirect URIs

Add both of these to the app's **Valid OAuth Redirect URIs**
(Facebook Login for Business → Settings), swapping in your deployment's
own domain:

```
https://your-domain.com/api/account/channels/messenger/oauth/callback
https://your-domain.com/api/account/channels/instagram/oauth/callback
```

This must exactly match `NEXT_PUBLIC_SITE_URL` (see `.env.local.example`)
— set that env var explicitly rather than relying on request-header
guessing, since a mismatch here is the most common OAuth failure.

## 4. Register the webhook URLs

Same App Dashboard, under each product's **Webhooks** setup:

```
Messenger:  https://your-domain.com/api/messenger/webhook
Instagram:  https://your-domain.com/api/instagram/webhook
```

Subscribe to the `messages` field for each. The verify token is whatever
you'll type into the account's Settings → Channels panel after
connecting — same self-service pattern as WhatsApp's verify token
(see `docs/multi-waba.md`).

## 5. Connect from the app

Settings → Channels → Messenger (or Instagram) → **Connect with
Facebook**. If the signed-in Facebook user administers more than one
Page, you'll be asked to pick one. Instagram additionally requires that
Page to have a linked Instagram professional account — connecting fails
with a clear error otherwise.

## 6. App Review

Before real (non-test) users can message your Page/Instagram account,
Meta requires **App Review** approval for `pages_messaging` and
`instagram_manage_messages` — a submission through your own Meta
Developer account (use-case description, screencast), same as the
WhatsApp Business API app already went through. Until approved, the
integration works fully for accounts added as testers/admins on the app
in Meta's dashboard.

## What's not supported yet

Templates and interactive buttons/lists (automation `send_template`,
`send_buttons`, `send_list` steps) are WhatsApp-only. Neither Messenger
nor Instagram has anything resembling WhatsApp's pre-approved HSM
template system, and Messenger's quick-replies are a different payload
shape (up to 13, vs. WhatsApp's 3 buttons) that needs its own mapping —
deferred to a later release. Plain text and media (`send_message`) work
on both channels today, from the composer and from automations.
