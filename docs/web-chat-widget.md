# Web Chat Widget — setup and configuration

The Web Widget is a second inbound channel alongside WhatsApp: a
self-hosted chat bubble you embed on your own website (or inside a
mobile app's WebView) with one `<script>` tag. Visitors chat
anonymously — no WhatsApp number, no app install — and their messages
land in the same Inbox, run through the same automations, and get the
same AI auto-reply as WhatsApp conversations do. Introduced in
migration 046; see `supabase/migrations/046_channels.sql` for the
original schema and RLS, and migration 048
(`supabase/migrations/048_merge_channel_conversations.sql`) for the
omnichannel merge described below. **Web Widget v2** (migration 092,
`supabase/migrations/092_widget_v2.sql`) added identity levels, signed
in-app identity, possible-duplicate suggestions, an enquiry form, files
and voice notes, read receipts, and English / Bahasa Melayu / Mandarin.
Migration 110 (`supabase/migrations/110_widget_email_verification.sql`)
added real email-code verification for a typed claim and a "you have a
new reply" email for a verified visitor who has left — see "Web
verification switch" and "Agent replies after the visitor left" below.

## What lives where

| Value | Lives in | Scope |
| --- | --- | --- |
| Widget name, welcome message, color, position, allowed origins, enabled toggle | `web_widget_config` (one row per account) | per account |
| `widget_token` (public, non-secret — embedded in the `<script>` tag) | `web_widget_config.widget_token`, generated once on first save | per account |
| A visitor's browser session | Supabase **anonymous auth** (`auth.users`, `is_anonymous = true`) | per browser/device |
| How a visitor's typed identity would be confirmed on the web | `web_widget_config.verification_mode` (`none` / `email_code` live; `whatsapp_code` stored, "coming soon") | per account |
| A pending email-code verification | `widget_verification_codes` (one row per browser; migration 110, service-role only) | per browser/device |
| The last "you have a new reply" email sent for a conversation | `widget_reply_notifications` (migration 110, service-role only) | per conversation |
| The in-app identity secret (signs tokens for your signed-in users) | `web_widget_config.identity_secret_enc` (AES-256-GCM ciphertext; only the last four characters are readable, `identity_secret_last4`) | per account |
| A visitor's *identity* — who they actually are | A signed in-app token (verified), or a phone/email they typed (claimed), matched against existing `contacts` | per phone/email, not per browser |
| The browser ↔ contact binding and its identity level (skips the first screen on return visits) | `widget_visitors` (row per anonymous auth uid → `contact_id`, with `identity_level`, `identity_source`, `identity_verified_at`) | per browser/device |
| Unverified claims that matched two contacts | `contact_merge_suggestions` (agents Merge or Dismiss) | per account |
| Enquiry form submissions | `widget_enquiries` (with `consent_at`) | per account |
| A visitor's conversation | The contact's single `conversations` row (migration 048 — shared with WhatsApp, not a separate widget-only row) | per contact |
| Which channel a given message came in/went out on | `messages.channel_type`, per message | per message |
| The conversation's most recent channel (drives UI badges + reply routing) | `conversations.last_channel_type` | per conversation |
| Anonymous sign-ins toggle | Supabase dashboard → Authentication → Sign In / Providers | **per Supabase project** — not settable from wacrm |

The widget bundle itself is a small self-contained Preact app built by
`scripts/build-widget.mjs` into `public/widget/loader.js`, wired into
`npm run build` ahead of `next build` — a normal deploy always ships a
current bundle, no separate step.

## Setup

### 1. Enable anonymous sign-ins (one-time, per Supabase project)

The widget authenticates every visitor with Supabase's built-in
anonymous auth (`supabase.auth.signInAnonymously()`) so Row Level
Security can scope what they can read — this is what makes "visitor
sees only their own conversation" a database-enforced guarantee rather
than something the client has to be trusted to respect. This can't be
turned on by a migration; it's a project-level Auth setting:

Supabase dashboard → your project → **Authentication → Sign In /
Providers → Anonymous Sign-ins → Enable**.

Without this, the widget's session bootstrap fails immediately and no
visitor can start a chat.

### 2. Configure the channel

**Settings → Channels → Web Widget** (admin+ role required to save;
any account member can view). Fields:

- **Enabled** — the widget refuses new sessions while off (existing
  conversations stay visible in the Inbox either way).
- **Widget name** — shown in the chat panel header.
- **Welcome message** — shown above the message list before the
  visitor's first send.
- **Primary color** — the launcher button, header background, and the
  visitor's own message bubbles.
- **Position** — bottom-left or bottom-right.
- **Allowed origins** — a CORS allow-list for the public API routes
  the widget calls (`/api/widget/session`, `/message`, `/upload-url`,
  `/receipt`, `/enquiry`). Enter full origins (`https://example.com`),
  not paths. **Leave empty to allow any origin** — the visible,
  copy-pasted `widget_token` is the actual embedding boundary for most
  setups, same as other chat-widget products; only set this if you
  specifically want to pin the widget to known domains.

- **Web verification** — `none` today (see "Visitor identity"); the
  code-based modes are shown as "coming soon".
- **In-app identity** — generate or rotate the secret your own server
  signs identity tokens with, and copy ready-made Node / PHP / Python
  snippets (see "Visitor identity").

Saving for the first time generates the account's `widget_token` and
reveals the embed snippet. That token never changes on later saves —
once you've pasted the snippet onto your site, it keeps working.

### 3. Embed it

Copy the snippet from the Web Widget panel and paste it once, anywhere
before the closing `</body>` tag, on every page you want the chat
bubble to appear:

```html
<script src="https://<your-host>/widget/loader.js" data-widget-token="wt_..." async></script>
```

Optional attributes on that tag: `data-identity-token` (an in-app
identity signed by your server, see "Visitor identity"), `data-lang`
(`en`, `ms` or `zh`) and `data-open="true"`. That's the whole
integration — no other markup, no CSS to load. The
widget mounts itself inside a Shadow DOM, so it can't collide with
your page's styles and your page's styles can't leak into it. It
works the same way inside a mobile app's WebView, since a WebView is
just rendering the page.

### 4. Test it

Click **Test chat** next to the embed snippet — it opens a small
popup already connected and open to a conversation, no need to have
the snippet live on a real page first. Send a message and it should
appear in the CRM's Inbox under a conversation badged with the
widget's channel icon; reply from the dashboard and it should appear
back in the popup within about a second, with no page reload
(Supabase Realtime, not polling). This is the exact widget code path a
real visitor gets — the popup just auto-opens the panel
(`/widget-preview`, `data-open="true"`) instead of requiring a click
on the launcher bubble.

The test page also has a **Simulate an in-app user** box: enter a phone
and/or email and it asks the dashboard (an admin-only route,
`POST /api/account/channels/web-widget/identity-token`, signed with your
real in-app identity secret) for a signed token and hands it to the
widget with `window.VircleWidget.identify({ token })`, exactly as a host
app's backend would. Use it to see the **Verified in-app** badge in the
Inbox. It needs the secret to have been generated first, and you must be
signed in as someone who can manage channels in the same browser.

## How it works, briefly

- **Reads** (message history, live updates) go straight from the
  visitor's browser to Supabase — a plain `SELECT` for history on
  load, and a `postgres_changes` Realtime subscription for anything
  after that — scoped by the visitor's own anonymous-auth session
  against the `messages_widget_visitor_select` /
  `conversations_widget_visitor_select` RLS policies. No server route
  is in that path.
- **Sends** go through `POST /api/widget/message` (not a direct
  client insert) specifically so the same request can also run
  automations, AI auto-reply, and outbound webhooks synchronously —
  the identical fan-out a WhatsApp inbound message gets from the
  webhook route. This is the one deliberate exception to "reads and
  writes both go direct."
- The public routes (`/api/widget/session`, `/message`, `/upload-url`,
  `/receipt`, `/enquiry`) verify the visitor's Supabase JWT server-side
  and are rate-limited (`RATE_LIMITS.widgetSession`, `widgetMessage`,
  `widgetIdentity*`, `widgetUpload`, `widgetReceipt`, `widgetEnquiry*` in
  `src/lib/rate-limit.ts`). `/session` and `/message` answers changed in
  v2 (see "Visitor identity" and "Messages, media, voice notes and
  ticks"); old cached loaders keep working through legacy fields.
- A widget visitor is a real `contacts` row and a real `conversations`
  row — the *same* conversation as their WhatsApp thread if they've
  messaged this business there too (migration 048 merges by contact,
  not by channel) — so tags, labels, priority, contact notes, deals,
  and reporting all work on it exactly as they do on a WhatsApp-only
  conversation. `messages.channel_type` records which channel each
  individual message used; `conversations.last_channel_type` is a
  rollup of the most recent one, and is what an agent's reply defaults
  to sending on.

## Visitor identity

Web Widget v2 (migration 092) replaced the old "verified vs
self-service" split with three explicit **identity levels**, stored per
browser on `widget_visitors.identity_level` and shown to agents as a
badge in the Inbox thread header:

| Level | How a visitor gets it | Agent badge | May it auto-merge two real contacts? |
| --- | --- | --- | --- |
| `guest` | Chose to stay anonymous (or is on the enquiry flow before submitting) | none | n/a |
| `claimed` | **Typed** a phone number and/or email ("I am already a user"), or filled the enquiry form | **Unverified web claim** | **No** |
| `verified` | The host app's own backend **signed** an identity token with the workspace secret | **Verified in-app** | Yes |

A returning browser resumes its stored level and can only move up
(`guest` to `claimed` to `verified`), never down. There is no verification
step for typed identities on the web today (see "Security notes"), so
**only a signed token proves anything.**

### The first screen

A brand-new browser with nothing offered gets `needsIdentity: true` from
`POST /api/widget/session` and the widget shows a choice:

1. **I am already a user** asks for a phone number and/or email (a `claim`).
2. **I have an enquiry** shows the enquiry form (below).
3. **Just chat** (guest) starts an anonymous conversation.

A host app that signs its users in never sees this screen: it hands the
widget a signed token (below) and the composer opens straight away.

### In-app identity (signed token)

For a mobile app WebView, or any site with its own login. The host's
**server** signs a short token for the signed-in user with the workspace's
secret, and puts it in the embed tag or hands it over later.

1. **Generate the secret**: Settings, Channels, Web Widget, *In-app
   identity*, **Generate secret**. It is shown **once** (copy it now); it
   is stored encrypted (AES-256-GCM, the same helper the WhatsApp, Gmail
   and Jira connections use) with only its last four characters readable.
   **Rotate** replaces it and immediately invalidates every token signed
   with the old one; **Turn off** erases it. Both are audited by column
   name only, never by value.
2. **Sign a token on your server** (snippets for Node, PHP and Python are in
   the settings card, and below). Format:

   ```
   token   = base64url(payloadJson) + "." + base64url(HMAC_SHA256(secret, base64url(payloadJson)))
   payload = { "phone"?, "email"?, "walletId"?, "name"?, "iat": <unix seconds> }
   ```

   At least one of `phone` (E.164), `email` or `walletId` is required. The
   server accepts `iat` up to **10 minutes old** and up to **60 seconds in
   the future** (clock skew); anything else is `expired_identity_token`. The
   signature is compared in constant time before the payload is trusted at
   all. A token that verifies makes the visitor `verified` (source
   `signed_app`); one that does not is reported as `identityError`
   (`bad_identity_token` | `expired_identity_token`) in a normal 200 and the
   visitor simply continues unidentified.

   ```js
   // Node.js
   import crypto from 'node:crypto'
   const SECRET = process.env.VIRCLE_WIDGET_SECRET   // server only, never in a page or app

   export function widgetIdentityToken(user) {
     const payload = { phone: user.phone, email: user.email, walletId: user.walletId,
                       name: user.name, iat: Math.floor(Date.now() / 1000) }
     const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
     const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url')
     return body + '.' + sig
   }
   ```

   The PHP and Python versions are in the settings card (they live in
   `src/lib/widget/snippets.ts`; the Node one is run by a unit test against
   the real verifier, so this page cannot drift from the code).
3. **Give the token to the widget**, either way:
   - **In the embed tag** (the host already knows the user when it renders
     the page):
     ```html
     <script src="https://<your-host>/widget/loader.js"
             data-widget-token="wt_..."
             data-identity-token="TOKEN_SIGNED_BY_YOUR_SERVER"
             async></script>
     ```
   - **Later**, when the host's own sign-in finishes after the script
     loaded (safe at any time; if the widget has not mounted yet the call is
     queued):
     ```js
     window.VircleWidget.identify({ token: tokenFromYourServer })
     ```

If the server rejects a token the widget logs a console warning and
dispatches a window event the host can listen for:

```js
window.addEventListener('vircle-widget:identity-error', (e) => {
  console.warn('Widget identity rejected:', e.detail.code)  // 'bad_identity_token' | 'expired_identity_token'
})
```

The other loader inputs: `data-lang="en|ms|zh"` (else the page's
`<html lang>`, else the browser language), `data-user-name` (a display-name
hint), and `data-open="true"` (start with the panel open; used by Test
chat). The **legacy** `data-user-phone`, `data-user-email`,
`data-user-wallet-id` and `identify({ phone, email, name })` still work so
existing embeds do not break, but they are unsigned, so the server treats
them as an **unverified claim**. The widget does not send a wallet id as a
claim; a wallet id is only accepted inside a signed token.

### Matching a typed or signed identity to a contact

A claim, a token or the enquiry form is matched against **CRM contacts
only**: by phone (the same trunk-prefix-tolerant match every other
phone-identified path uses) and by email (case-insensitive exact). A signed
token may also carry a `walletId`, matched exactly when nothing else did.

| Phone match | Email match | Verified (signed token) | Unverified (typed / form) |
| --- | --- | --- | --- |
| none | none | create a contact | create a contact (a claim also tags it **Claims existing user**) |
| A | none | use A | use A |
| none | B | use B | use B |
| A | A | use A | use A |
| A | B (different) | **merge B into A**, use A | use A and record a **Possible duplicate** suggestion (A, B); **never merges** |

The response's `claimFound` is `true` when an existing contact matched
(so the widget can say "Welcome back" instead of "Welcome"); it is the only
thing that ever reveals whether a contact exists. The response never says
which identifier matched, and `identity.displayName` is only ever the
contact's real name for a **verified** identity (for a typed claim it is
just the name the visitor typed in that same request), so a stranger who
types someone's phone number cannot read their name back out of the CRM.
Email, phone, wallet id and name are backfilled **only where empty**, and
for an unverified claim only the name is (a typed claim cannot plant its
own phone, email or wallet id on somebody's contact).

A visitor's own **guest** contact is always folded into the contact they
identify as (verified or not) with `merge_widget_guest_contact`
(migration 054): messages, labels, notes and deals move over and the widget
swaps to the merged conversation. Only two REAL contacts need the
"verified" rule above.

Typed claims are rate limited (`RATE_LIMITS.widgetIdentity`, 5 per 10
minutes per visitor, plus per widget token + origin and per IP) because each
one can answer `claimFound`. A valid signed token is a proof, not a probe,
so it never spends that budget. Over the limit is a `429` with
`code: 'rate_limited'` and `Retry-After`.

### Possible duplicates (agents)

When an unverified claim matches two contacts the visitor is attached to the
phone match and a row goes into `contact_merge_suggestions` (unique per pair,
so a dismissed pair is never suggested again). The Inbox thread shows a
**Possible duplicate** badge and an amber bar naming the other contact with
**Merge** and **Dismiss**. Merge calls the same `merge_contacts` function and
needs the same capability (`contacts.merge`) as the manual contact merge;
Dismiss needs it too. Both go through
`POST /api/contacts/merge-suggestions/[id]` (`{ action: 'merge' | 'dismiss' }`);
the table has no client write policy. The badges come from
`GET /api/contacts/[id]/widget-identity`.

### Web verification switch

Settings shows **Web verification**: `none` (live), `email_code` (live,
migration 110 — see below) and `whatsapp_code` (stored, still "coming
soon"). It is `verification_mode` on `web_widget_config` and is reported to
the widget as `verification: { mode }`. The API refuses to switch to
`whatsapp_code` today; switching to `email_code` additionally requires
`RESEND_API_KEY` to be configured (`isResendConfigured()`), since there
would otherwise be nothing to actually send the code with.

To add `whatsapp_code` later: implement its own send/verify pair mirroring
`src/lib/widget/email-verification.ts` / `src/app/api/widget/verify-code/route.ts`
(sending the code via the account's own connected WhatsApp number instead of
Resend), and add it to `IMPLEMENTED_VERIFICATION_MODES` in
`src/app/api/account/channels/web-widget/route.ts`. Nothing else needs to
change: the merge rule already keys on the identity level, not the
verification method.

#### Email-code verification (migration 110)

With **Web verification** set to `email_code`, the "I am already a user"
claim form works differently from the `none` default: instead of
immediately (and unverifiably) attaching the browser to whatever it typed,
the server looks the phone (or email) up against CRM contacts **without
creating or merging anything** — an unmatched claim leaves no trace at all,
by design, since the point of this mode is "must be an existing, real
customer." Only a real match **with an email on file** gets anything sent;
a match with no email is treated the same as no match (nothing to verify
through, so no code, no partial trust granted).

When there is a match with an email, a 6-digit code (`widget_verification_codes`,
one pending row per browser — a fresh claim overwrites it, which is also how
"resend the code" works, with no separate endpoint) is emailed to that
contact's **own** email on file — never the email the visitor typed, since
verifying an unproven typed value would defeat the purpose. The widget shows
a code-entry screen (`needsVerification: true`, `verification.maskedEmail`).
`POST /api/widget/verify-code` confirms it — 5 wrong attempts or 10 minutes
past `expires_at` invalidates the code (request a new one by resubmitting
the claim) — and success sets `identity_level = 'verified'`,
`identity_source = 'code'`: the same trust tier a signed in-app token gets,
including the guest-fold-in and the "may auto-merge two real contacts" rule
(see "Matching a typed or signed identity to a contact" above).

This is the piece that makes "ask for a registered phone number, verified,
with no manual step" work for a logged-out website visitor (or a logged-out
mobile-app WebView, which can carry no signed token at all) — the other
half of that picture, a **logged-in** mobile app or site, uses the signed
in-app token instead (see "In-app identity" above), since it already knows
who the visitor is.

### Enquiry form

`POST /api/widget/enquiry` saves the widget's enquiry form: **name**;
**phone or email** (at least one); **I am a** `parent | school | merchant |
other`; **message** (1 to 2000 characters); and a **consent** tick (must be
`true`). It:

- matches or creates the contact with the same **unverified** rules as a
  claim (a verified browser keeps its verified contact);
- makes a new contact a **lead** (`lifecycle_stage = 'lead'`) and tags the
  contact **Web enquiry** and **Enquiry: <role>**;
- records a `widget_enquiries` row (with `consent_at`);
- inserts the first customer message (`[Web enquiry - Parent]` and the text)
  and fires the **same fan-out as `/api/widget/message`**: `new_contact_created`
  for a new contact, `first_inbound_message` / `new_message_received` /
  `keyword_match` automations, AI reply and outbound webhooks. The existing
  routing (automations and assignment rules) therefore applies unchanged.
- answers with the same body as `/api/widget/session` (`identity.level` is
  `claimed`, `claimFound` says whether it matched).

It is rate limited (5 per hour per visitor, and per widget token + origin).

## Messages, media, voice notes and ticks

The panel is a WhatsApp-style chat: bubbles, timestamps with day dividers,
an emoji picker, image and video previews, file chips, a voice-note
recorder, and full screen on phones. Not yet built (later): typing
indicator, reply-to, reactions, link previews.

### Sending files and voice notes

Attachments never pass through the app server as bytes:

1. `POST /api/widget/upload-url` with `{ conversationId, fileName, mimeType,
   sizeBytes, kind }` answers `{ bucket: 'chat-media', path, token }`, a
   Supabase Storage **signed upload token** for exactly one object at
   `account-<accountId>/widget/<conversationId>/<uuid>-<safe file name>`. It
   is only issued when the visitor owns the conversation, the type is in the
   allow-list, the size is within the limit and `kind` matches the type
   (20 tokens per 10 minutes per visitor).
2. The widget uploads to Storage with
   `supabase.storage.from('chat-media').uploadToSignedUrl(path, token, blob, { contentType })`.
3. `POST /api/widget/message` with `{ conversationId, text?, media?,
   clientMessageId? }` where `media = { path, mimeType, fileName, sizeBytes,
   kind, durationSeconds? }`. The server **re-validates** the object: the
   path must be under this conversation's prefix, the object must exist in
   `chat-media`, and its real size and content type (read from Storage, not
   trusted from the request) must match what was declared and be within the
   rules. On a mismatch it **deletes the object** and answers `413` or `415`.
   `text` is the caption. The answer is `{ message: { id, created_at,
   status } }`, `status` starting as `sent`. Sending the same
   `clientMessageId` again returns the original message and fires nothing a
   second time, so a retry after a lost response is safe.

Limits (reported to the widget as `limits` by `/session` and `/enquiry`):
**16 MB per file**, **voice notes up to 5 minutes**, video up to 16 MB, and
the **same MIME allow-list as the `chat-media` bucket** (migration 023:
PNG, JPEG, WebP, MP4, 3GPP, PDF, Word, Excel, PowerPoint, plain text, and
Ogg, MPEG, AAC, MP4 and AMR audio). The bucket settings are not changed by
the widget; a unit test compares the widget's list with migration 023.
Error codes: `file_too_large` (413), `file_type_not_allowed` (415),
`bad_request` (400), `not_found` (404), `rate_limited` (429).

The message is stored as a normal `messages` row (`sender_type =
'customer'`, `channel_type = 'web_widget'`, `content_type` text | image |
video | audio | document, `media_url` the public `chat-media` URL) and then
gets the same fan-out as before (automations, AI reply, webhooks). Agents
reply with media the same way as on any channel: the Inbox composer's attach
menu (photo, video, document, voice note) is now available on web-widget
conversations too. Templates and interactive buttons/lists stay
WhatsApp-only.

### Sent, delivered, read

Agent to visitor: the widget reports what it received and displayed with
`POST /api/widget/receipt` `{ conversationId, messageIds, status:
'delivered' | 'read' }`, and the Inbox shows the usual ticks. Only agent or
bot messages, sent on the widget, in the visitor's own conversation, and not
internal comments, can change; **a status only moves forward** (a late
`delivered` never downgrades `read`).

Visitor to agent: a customer message starts `sent`; when an agent opens the
conversation (the Inbox resets `unread_count` to 0) a database trigger
(migration 092) flips the visitor's web-widget messages in it to `read`, and
the widget, which subscribes to Realtime UPDATEs on its own messages,
animates the ticks. (Bulk "mark as read" flips them too. "Delivered" is not
tracked for visitor messages.)

### Agent replies after the visitor left

An agent reply always appears in the widget, with an unread marker, the
next time that browser opens it — that part never changed. What migration
110 adds on top is the closest approximation to WhatsApp's own
"you get notified even when you're not looking" behavior that doesn't
require a mobile push SDK or a browser permission prompt: **for a
verified visitor with an email** (either the signed in-app token, or a
completed `email_code` verification — see above), a reply sent while
they appear to be away gets a plain "you have a new reply" email via
Resend (`src/lib/widget/notify-reply.ts`), fired best-effort from
`sendMessageToConversation` and never blocking or failing the agent's
send.

- **"Away"** means no `widget_visitors` row for that contact was
  `last_seen_at` within the last 2 minutes — a rough, cheap heuristic
  (there is no open-tab heartbeat), not a real presence system.
- Only **one** email per "away period": `widget_reply_notifications`
  (one row per conversation) is only re-armed once the visitor has
  actually been seen again since the last notification, so a burst of
  agent messages doesn't turn into a burst of emails.
- **Never sent for a `claimed` (unverified) identity** — its email
  could be a stranger's typo or guess, and notifying it would leak that
  a conversation exists to whoever typed it. This is deliberately more
  conservative than what the identity itself is trusted for elsewhere.
- No email is sent (silently) when `RESEND_API_KEY` isn't configured,
  the visitor has no verified email at all, or the visitor is a plain
  `guest` — the widget-only "appears next time they open it" behavior
  is always the floor, this is additive.
- **Not built**: real push (Web Push for a browser tab, or native push
  for a mobile app — a WebView, unlike a full native app, cannot use
  the Web Push API at all, so a mobile app wanting true OS-level push
  needs its own native integration regardless of anything here) and a
  WhatsApp-template fallback for a verified phone with no email. Both
  are bigger, separately-scoped follow-ons flagged rather than silently
  built partway.

### Languages

The widget speaks English, Bahasa Melayu (`ms`) and Mandarin (`zh`), chosen
from `data-lang`, the page's `<html lang>`, then the browser language. The
locale is also sent to `/session` and `/enquiry`.

### Host requirements for voice notes

The recorder is loaded lazily (`recorder.js`, like the emoji picker's
`emoji.js`) from the **API origin**, never from a CDN. To record, the widget
needs microphone access:

- **Iframe hosts**: the embedding `<iframe>` needs `allow="microphone"`.
- **Android WebView**: declare `RECORD_AUDIO` and grant the WebView's
  permission request (`WebChromeClient.onPermissionRequest`) once the user has
  allowed it.
- **iOS WKWebView**: add `NSMicrophoneUsageDescription` to `Info.plist`.
- **Strict CSP hosts**: the recorder encodes in a Web Worker started from a
  blob, so allow `worker-src blob:`, plus the API origin in `script-src` /
  `connect-src` / `img-src` (Storage media) as for the loader itself.

Where the microphone is unavailable or refused, the widget hides the
record button; files and text still work.

## What's channel-specific

Since a merged conversation can span both channels, "channel-specific"
now means "gated on `conversations.last_channel_type`" rather than a
fixed per-conversation property. The composer hides these whenever the
conversation's most recent message came in via the widget (media attach
is no longer one of them: photos, video, voice notes and files work on the
widget since v2), and the
server rejects them too if something tries anyway
(`sendMessageToConversation` in `src/lib/whatsapp/send-message.ts`, and
`assertWhatsappChannel` in `src/lib/automations/engine.ts`) — the same
guard re-evaluates on the customer's very next message, so these
affordances come back the moment they message in on WhatsApp again:

- Message templates and interactive buttons/lists — Meta-specific
  concepts with no widget equivalent yet. (Text and media messages are
  delivered on the widget by persisting the message row; the visitor's
  widget shows it live and reports delivered / read.)
- The visual **Flow builder** doesn't run for widget conversations —
  its send nodes call Meta's API directly rather than going through
  the channel-aware send core, so a Flow with an interactive node
  would error against a widget contact. Plain **Automations** remain
  fully available: `send_message` works on both channels, and
  WhatsApp-only step types fail with a clear logged error instead of
  silently misfiring.

Everything else — labels, internal comments, handoff notes, priority,
assignment/teams, contact tags and custom fields — works identically
across both channels.

## Automating priority for widget visitors

A common ask is routing widget chats from known/VIP contacts to the
top of the queue. There's no separate "VIP" concept to build — wire it
with what already exists: a custom field on the contact (e.g. `VIP =
true`), a `condition` step checking that field, and a `set_priority`
step (added alongside this channel; see
`supabase/migrations/047_conversation_priority.sql`) setting `urgent`.
Works the same for WhatsApp and widget conversations.

## Security notes

- **No verification on the web (accepted risk).** A visitor who types a real
  customer's phone or email lands on that customer's contact record and, since
  the conversation is one merged thread (migration 048), can see that
  customer's past messages through the widget. That is the trade-off chosen
  for one unified thread with no OTP. What v2 changes is that this is now
  visible and contained: the visitor is labelled **Unverified web claim**;
  a typed claim never auto-merges two real contacts and never plants its own
  phone, email or wallet id on a contact; the response reveals a contact's
  name only for a verified identity; and claims are rate limited. RLS still
  scopes a visitor to their contact's conversation only, never tags, deals or
  notes. If an account expects sensitive content (payments, account changes)
  over the widget, do not rely on typed identity: use in-app identity, or turn
  on code verification when it ships (see "Web verification switch").
- **The identity secret** signs tokens for **any** customer, so treat it like
  an API key: server side only, in an environment variable, never in a page or
  app bundle. Rotate it if it may have leaked (every old token stops working at
  once). It is stored encrypted at rest; the settings screen only ever holds
  its last four characters.
- **Tokens are short-lived, not one-time.** A token is valid for 10 minutes
  from its `iat`; someone who copies it from the page source inside that window
  can reuse it. Mint one per page render, never cache it long, and do not put it
  in a URL.
- Signature verification is constant time and happens before the payload is
  read; an expired token from the wrong secret is reported as a bad token, not
  as expired.
- **Uploads are scoped and re-checked.** A signed upload token is for one path
  under the visitor's own conversation; the message route re-reads the stored
  object's real size and type and deletes a mismatch.
- The public widget routes are `/api/widget/session`, `/message`,
  `/upload-url`, `/receipt` and `/enquiry`. All are CORS-enabled and checked
  against the account's `allowed_origins`; all except `/session` and
  `/enquiry` need the visitor's anonymous-auth JWT plus an existing
  `widget_visitors` row (those two verify the JWT and create it). Error shape:
  `{ error, code? }`.

## Migration 092

Apply `supabase/migrations/092_widget_v2.sql` **before** deploying the code
that reads it: `web_widget_config` gains `verification_mode` and the encrypted
`identity_secret_*` columns, `widget_visitors` gains `identity_level` /
`identity_source` / `identity_verified_at` (existing browsers with a phone
become `claimed`), and new tables `contact_merge_suggestions` and
`widget_enquiries` (read by account members, written only by the API), a
`lower(email)` index on contacts, the read-ticks trigger on
`conversations.unread_count`, and the audit trigger on the widget config now
also names `verification_mode` and `identity_secret_enc` (by name, never
value). It does not touch the `chat-media` bucket. It is additive and
idempotent; `supabase/ci/verify-092-widget-v2.sql` (run with the migration
ahead of it in one file; it ends in a deliberate `ROLLBACK-OK` error) proves
the constraints, the suggestion uniqueness, RLS and grants, the read ticks,
that secrets are audited by name only, and that the guest merge still works.

## Local development

The widget bundle needs `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY` at **build** time (they're inlined
into the bundle, the same as Next.js does for the dashboard's own
client code) — set in `.env.local` like everything else.

```
npm run build:widget         # one-off build → public/widget/loader.js
npm run build:widget:watch   # rebuild on change, with inline sourcemaps
```

`npm run dev` does not rebuild the widget automatically — run
`build:widget` (or `build:widget:watch` in a second terminal) after
editing anything under `widget/src/`, then hard-refresh the test page.

## Troubleshooting

- **Launcher never appears / console error "missing
  data-widget-token"** — the `<script>` tag's `data-widget-token`
  attribute is missing or the script failed to load. Confirm the
  `src` URL resolves and returns JS, not a 404.
- **"Failed to start an anonymous session"** — anonymous sign-ins are
  disabled on the Supabase project (step 1 above), or the widget
  bundle was built against a different Supabase project than the one
  the CRM itself uses.
- **`403 Origin not allowed for this widget`** — the page embedding
  the widget isn't in `allowed_origins`. Either add it in Settings →
  Channels → Web Widget, or clear the list to allow any origin.
- **`404 Widget not found or disabled`** — the `widget_token` in the
  snippet doesn't match any account's config, or the widget is
  currently switched off in Settings.
- **Messages send but never appear in the Inbox** — confirm migrations
  046, 047, and 048 are all applied to the account's Supabase project
  (`supabase migration list` should show all three on the
  `remote` side) and that the account's RLS policies weren't hand-
  edited; `conversations_widget_visitor_select` and
  `messages_widget_visitor_select` are what let the visitor read back
  the same rows the dashboard sees.
- **`identityError: bad_identity_token` in the console / the
  `vircle-widget:identity-error` event** — the token was not signed with
  the workspace's CURRENT secret (rotated since?), is malformed, or has no
  phone / email / wallet id. `expired_identity_token` means its `iat` is
  more than 10 minutes old (or more than 60 seconds ahead of the CRM's
  clock): mint a fresh token per page render and check the server clocks.
- **A visitor shows "Unverified web claim" although they are signed in to
  your app** — the token did not reach the widget (or was rejected, see
  above); a phone number in the legacy `data-user-phone` attribute is only
  ever a claim.
- **`429` with `code: rate_limited` on `/session`** — more than 5 typed
  claims in 10 minutes from one visitor (or the per-origin / per-IP
  budget). Signed tokens never count. Honour `Retry-After`.
- **Attachments fail with 413 / 415** — over 16 MB, or a type outside the
  `chat-media` allow-list (for example GIF, SVG, HTML, WebM). Voice notes
  are recorded as Ogg/Opus for that reason.
- **The voice button is missing** — the page cannot use the microphone (no
  HTTPS, iframe without `allow="microphone"`, or a WebView without the
  permission). See "Host requirements for voice notes".
- **Checking the schema** — `supabase migration list` should show 092 and
  110; the verify scripts are `supabase/ci/verify-092-widget-v2.sql` and
  `supabase/ci/verify-110-widget-email-verification.sql`.
- **"Set RESEND_API_KEY before enabling email-code verification"** —
  Settings → Channels → Web Widget → Web verification refused to save
  `email_code` because `isResendConfigured()` is false. Set
  `RESEND_API_KEY` (and, for real deliverability, `RESEND_FROM_EMAIL` —
  see `.env.local.example` and `docs/sso-login-setup.md`'s "Email
  delivery" section) first.
- **A visitor's claim never leads to a code / just says nothing
  matched** — with `email_code` verification on, an unmatched phone/email,
  or a match with no email on file, both get the same "we could not find
  that" outcome on purpose (see "Email-code verification" above) — check
  the contact actually exists in this account with an email set.
- **No "new reply" email arrives for an away visitor** — confirm the
  visitor's identity level is `verified` (a `claimed`/unverified email is
  never notified), that `RESEND_API_KEY` is set, and that they were
  genuinely away (`widget_visitors.last_seen_at` for their contact older
  than 2 minutes) — an open tab that already showed the reply live via
  Realtime correctly gets no email.
- **A reply from the dashboard doesn't show up live in the widget**
  — check the browser console for a Realtime `CHANNEL_ERROR`/`TIMED_OUT`
  on the `widget-messages-<id>` channel; this usually means the
  anonymous session expired mid-visit. Reloading the page re-runs
  `signInAnonymously()` and reconnects.
