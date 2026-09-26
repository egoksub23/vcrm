# Sign in with Google / Microsoft

Lets someone log in or sign up with their Google or Microsoft work
account instead of setting a password. This is **login only** — a
separate, unrelated thing from the [Gmail](./gmail-setup.md) and
[Microsoft 365](./microsoft-365-email-setup.md) *channels*, which
connect one shared mailbox for sending/receiving customer email. Use a
**separate** Google Cloud OAuth client and Azure AD app registration
for this — don't reuse the channel ones. They ask for very different
permissions (this only ever needs `openid email profile`; the channel
apps hold `Mail.Send`/`Mail.Read`), and keeping them apart means
disconnecting a mailbox channel can never accidentally break login for
the whole account.

This app ships the buttons and the callback route
(`src/components/auth/oauth-buttons.tsx`,
`src/app/auth/callback/route.ts`) already wired up — Google/Microsoft
sign-in appears on `/login` and `/signup` the moment the providers
below are turned on in Supabase Auth. There's no per-app env var to set
for this feature beyond `NEXT_PUBLIC_SITE_URL`, which you likely
already have set (see `.env.local.example`) — the OAuth client
ID/secret live in Supabase's own configuration, not this app's.

## What this does and doesn't change

- **Adds** "Continue with Google" / "Continue with Microsoft" as
  another way to authenticate — password login is unchanged and stays
  available.
- **Invites can now optionally be email-targeted** (shipped after this
  doc was first written — see "Invite by email" below). A plain
  shareable link (no email set) still works exactly as before: anyone
  with it can redeem it with any account. Setting an email on an invite
  is what makes SSO sign-in place someone automatically, with no link
  click at all.
- **Does not** let you require SSO for an account or block password
  login for specific users — everyone can always still use a password
  unless you build that enforcement separately.

## Invite by email

An admin can optionally target an invite at a specific email address
(Settings → Team → Invite a teammate → "Email address"). When set:

- The moment that **exact, verified** email signs in — including
  immediately via Google/Microsoft SSO, since the provider has already
  verified it — they're placed straight into the invited account at the
  invited role. No link click, no "Accept" step.
- For a password signup, the same auto-join happens once they confirm
  their email (click the verification link) — verification is what
  makes it safe; an unconfirmed email is never trusted for this, so
  someone can't claim an invited address before actually proving they
  own it.
- The invite link still works too (and is now also checked against the
  target email) as a fallback, or for cases with no auto-match event
  (e.g. the person already had an account here before being invited).
- If the invited person already has real data in their own account
  under that email, auto-join is skipped rather than silently
  discarding it — the invitation stays pending for the admin/user to
  resolve manually (same "your account already contains data" guard the
  link-accept flow has always had).
- **Sends an email when Resend is configured** (`RESEND_API_KEY` — see
  "Email delivery" below). Without it, no email goes out — the admin
  still shares the invite the same way as any link invite (WhatsApp,
  Slack, verbally), same as before this existed; auto-join on sign-in
  works either way. With it, the create-invite dialog shows whether the
  email actually sent, and the Members list shows an "Email sent" badge
  on invitations it went out for.
- **Does not** let you require SSO for an account or block password
  login for specific users — everyone can always still use a password
  unless you build that enforcement separately.

## Email delivery (optional — Resend)

By default, an email-targeted invite is never emailed — the admin
copies the link from the create-invite dialog and shares it themselves
(WhatsApp, Slack, verbally), and auto-join on verified sign-in still
works regardless. Setting `RESEND_API_KEY` (see `.env.local.example`)
makes `POST /api/account/invitations` actually send that link to the
invited address via [Resend](https://resend.com):

1. Create a Resend account and an API key (dashboard → API Keys).
2. Set `RESEND_API_KEY` in your environment.
3. Verify a sending domain (dashboard → Domains → Add Domain, then add
   the DNS records it gives you) and set `RESEND_FROM_EMAIL` to an
   address on that domain, e.g. `invites@crm.example.com`. Without this,
   sends fall back to Resend's own `onboarding@resend.dev` sandbox
   sender, which only delivers to the email address of the Resend
   account itself — useful for a first try, not for real invites.
4. Invite a teammate by email (Settings → Team → Invite a teammate →
   "Email address") — the create-invite dialog reports whether the
   email actually sent; if it didn't (not configured, or Resend
   returned an error), the link is still shown so you can share it
   yourself.

A failed or unconfigured send never blocks invite creation — this is
additive on top of the existing link-and-auto-join behavior, not a
replacement for it.

## 1. Google Cloud OAuth client

In the [Google Cloud Console](https://console.cloud.google.com), under
**APIs & Services → Credentials → Create Credentials → OAuth client
ID**:

- **Application type**: Web application
- **Authorized redirect URI** — this is **Supabase's** callback, not
  this app's:
  ```
  https://<your-project-ref>.supabase.co/auth/v1/callback
  ```
  Find your project ref in the Supabase dashboard URL or under
  **Project Settings → General**. (This app's own
  `/auth/callback` route is registered with *Supabase*, as the
  `redirectTo` — you don't register it with Google directly.)

Copy the **Client ID** and **Client secret** — you'll paste them into
Supabase in step 3, not into this app's `.env`.

## 2. Azure AD (Entra ID) app registration

In the [Azure Portal](https://portal.azure.com) → **Microsoft Entra ID
→ App registrations → New registration**:

- **Supported account types**: "Accounts in any organizational
  directory and personal Microsoft accounts" is the closest match to
  "any Microsoft 365 user can sign in" — narrow this to your own
  tenant only if you want to restrict sign-in to your organization.
- **Redirect URI** (platform: Web) — again, Supabase's callback:
  ```
  https://<your-project-ref>.supabase.co/auth/v1/callback
  ```
- Under **Certificates & secrets → New client secret**, create one and
  copy its **value** immediately (Azure only shows it once).
- Copy the **Application (client) ID** from the app registration's
  Overview page.

## 3. Enable both providers in Supabase Auth

**Supabase Cloud project** — dashboard → **Authentication →
Providers**:
- **Google**: toggle on, paste the Client ID/secret from step 1.
- **Azure**: toggle on, paste the Application (client) ID/secret from
  step 2. Leave "Azure Tenant URL" as the default (`common`) unless you
  deliberately restricted sign-in to one tenant above, in which case it
  must match.

**Self-hosted Supabase/GoTrue** (docker-compose) instead — set instead
in your Supabase environment (not this app's):
```
GOTRUE_EXTERNAL_GOOGLE_ENABLED=true
GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID=...
GOTRUE_EXTERNAL_GOOGLE_SECRET=...
GOTRUE_EXTERNAL_AZURE_ENABLED=true
GOTRUE_EXTERNAL_AZURE_CLIENT_ID=...
GOTRUE_EXTERNAL_AZURE_SECRET=...
GOTRUE_EXTERNAL_AZURE_URL=https://login.microsoftonline.com/common
```

## 4. Try it

Once both providers show enabled in Supabase, reload `/login` — the
two buttons appear automatically, no redeploy of this app needed (they
were already shipped; they were just inert with no provider to call).
Test both the plain `/login` path and an invite link
(`/join/<token>` → "I already have an account" → "Continue with
Google") to confirm the redirect back lands on the invite-accept
screen, not `/dashboard`.

## Troubleshooting

- **"redirect_uri_mismatch" from Google/Microsoft** — the redirect URI
  registered with the provider doesn't exactly match
  `https://<project-ref>.supabase.co/auth/v1/callback`. This is the
  #1 misconfiguration: it's easy to accidentally register *this app's*
  domain instead of Supabase's.
- **Lands back on `/login?error=oauth_failed`** — `exchangeCodeForSession`
  failed in `src/app/auth/callback/route.ts`; check the server logs for
  the underlying Supabase error (a stale/reused code, or the provider
  not actually enabled yet).
- **New Google/Microsoft sign-in creates its own separate personal
  account instead of joining an existing one** — expected unless they
  came in via an invite link. Every new `auth.users` row (any sign-in
  method) gets a personal "owner" account from the existing
  `handle_new_user` trigger; redeeming an invite is what moves them
  into a shared one. See "What this does and doesn't change" above.
