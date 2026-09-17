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
omnichannel merge described below.

## What lives where

| Value | Lives in | Scope |
| --- | --- | --- |
| Widget name, welcome message, color, position, allowed origins, enabled toggle | `web_widget_config` (one row per account) | per account |
| `widget_token` (public, non-secret — embedded in the `<script>` tag) | `web_widget_config.widget_token`, generated once on first save | per account |
| A visitor's browser session | Supabase **anonymous auth** (`auth.users`, `is_anonymous = true`) | per browser/device |
| A visitor's *identity* — who they actually are | The phone number they type into the pre-chat gate, matched against existing `contacts` | per phone number, not per browser |
| The browser ↔ contact binding (skips the gate on return visits) | `widget_visitors` (row per anonymous auth uid → `contact_id`) | per browser/device |
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
- **Allowed origins** — a CORS allow-list for the two public API
  routes the widget calls (`/api/widget/session`,
  `/api/widget/message`). Enter full origins (`https://example.com`),
  not paths. **Leave empty to allow any origin** — the visible,
  copy-pasted `widget_token` is the actual embedding boundary for most
  setups, same as other chat-widget products; only set this if you
  specifically want to pin the widget to known domains.

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

That's the whole integration — no other markup, no CSS to load. The
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
- Both public routes (`/api/widget/session`, `/api/widget/message`)
  verify the visitor's Supabase JWT server-side and are rate-limited
  (`RATE_LIMITS.widgetSession`, `RATE_LIMITS.widgetMessage` in
  `src/lib/rate-limit.ts`).
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

A first-time visitor's identity can arrive three ways (migration 054):

1. **Verified, from the host app** — an in-app/WebView embed that
   already has a signed-in, verified user hands the widget their phone
   (and optionally a wallet ID and email) at init. No gate is ever
   shown; the composer appears immediately. Two ways to pass it:
   - **Synchronous** — `data-user-phone` / `data-user-wallet-id` /
     `data-user-email` attributes on the loader `<script>` tag, for a
     host that already knows the user before it injects the widget:
     ```html
     <script src="https://<your-host>/widget/loader.js"
             data-widget-token="wt_..."
             data-user-phone="+60123980112"
             data-user-wallet-id="wallet_abc"
             data-user-email="jane@example.com"
             async></script>
     ```
   - **Async** — `window.VircleWidget.identify({ phone, walletId, email })`,
     for a host whose own sign-in finishes *after* the script has
     already loaded and the widget has possibly already started an
     anonymous or guest session. Safe to call at any point — if the
     widget hasn't mounted its listener yet, the call is queued and
     delivered as soon as it has. A visitor already chatting as a guest
     gets their history folded into the now-identified contact (see
     "self-service linking" below); an anonymous/unstarted session just
     resolves straight to the identified contact.
   All three fields are **optional** and independent of each other —
   only `phone` drives identity resolution; `walletId`/`email` are
   informational, stored on the contact (`wallet_id` is new, `email`
   already existed) but never used for matching. Passing none of them
   falls through to case 2 below exactly as if this were a plain web
   embed.
2. **Self-service** — right after the welcome message, a visitor with
   no verified identity is asked *"Are you already a Vircle user?"*.
   **Yes** reveals a phone (and optional name) field; submitting it
   works exactly like case 1 except unverified — see the trust-model
   note below. **No** (or ignoring the prompt) starts a plain anonymous
   guest session — `phone: ''`, keyed only by `widget_visitor_id` — and
   the composer appears immediately either way.
3. **Guest, later linking** — a visitor chatting as a guest (case 2's
   "No") can identify themselves at any point via the composer's
   "Already a Vircle user? Link your account" prompt. Their guest
   session's history (messages, any labels/notes/deals an agent
   happened to attach while they were still anonymous) gets folded
   into the phone-matched contact by `merge_widget_guest_contact`
   (migration 054) — the same repoint-then-delete shape migration 048
   uses for its own conversation merges, just generalized into a
   callable function since this has to run at arbitrary request time,
   not once during a migration window. The widget swaps to the merged
   conversation and refetches history automatically; nothing is lost.

Phone-first identity either way: whatever phone is resolved (verified
or self-service) is looked up against the account's existing contacts
(the same fuzzy, trunk-prefix-tolerant match every other phone-
identified path in the app uses) — if it matches someone who has
already messaged this business on WhatsApp, the widget attaches to
that **same contact record — and the same conversation**. There's no
separate widget-only thread: it's one merged conversation with the
customer's full history in it regardless of which channel each
message came in on (migration 048). If it's a new number, a new
contact — and a new conversation — is created from it.

A returning visitor on the **same browser** skips straight to their
resolved contact — `widget_visitors` already remembers which contact
this browser belongs to from last time, so identity (verified,
self-service, or guest) is only ever resolved once per device.

**Case 1 (verified) is trusted; cases 2 and 3 are intentionally
unverified — there's no OTP.** A self-service visitor who types a real
customer's phone number lands their chat on that customer's contact
record — and, since the merge, on their actual conversation history
too, not just a fresh empty thread. The widget still doesn't leak
anything beyond that one conversation: RLS scopes a visitor to their
contact's conversation specifically, never the contact's tags, deals,
or notes — that data stays dashboard-only. But because the merged
conversation can include past WhatsApp messages, the accepted risk is
a little larger than before: someone typing a real customer's number
now sees that customer's past conversation content through the widget,
not just an empty chat. That's the trade-off explicitly chosen here in
exchange for one unified thread — worth keeping in mind for any
account expecting to receive sensitive content (payment details,
account changes) over either channel. OTP verification on the
self-service phone claim is a real, flagged hardening follow-up, not
silently skipped — it just isn't built yet. Case 1 doesn't carry this
risk to begin with: the host app already verified the phone belongs to
its signed-in user before ever calling the widget.

## What's channel-specific

Since a merged conversation can span both channels, "channel-specific"
now means "gated on `conversations.last_channel_type`" rather than a
fixed per-conversation property. The composer hides these whenever the
conversation's most recent message came in via the widget, and the
server rejects them too if something tries anyway
(`sendMessageToConversation` in `src/lib/whatsapp/send-message.ts`, and
`assertWhatsappChannel` in `src/lib/automations/engine.ts`) — the same
guard re-evaluates on the customer's very next message, so these
affordances come back the moment they message in on WhatsApp again:

- Message templates, interactive buttons/lists, and media attach —
  all Meta-specific concepts with no widget equivalent yet.
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
- **A reply from the dashboard doesn't show up live in the widget**
  — check the browser console for a Realtime `CHANNEL_ERROR`/`TIMED_OUT`
  on the `widget-messages-<id>` channel; this usually means the
  anonymous session expired mid-visit. Reloading the page re-runs
  `signInAnonymously()` and reconnects.
