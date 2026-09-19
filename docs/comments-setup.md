# Comments: Facebook, Instagram and TikTok

The inbox has a third tab, **Comments**, next to Chats and Emails. It collects
public comments on your Facebook Page posts (including ads), your Instagram
posts and your TikTok videos. From there an agent can:

| Action | Facebook | Instagram | TikTok |
|---|---|---|---|
| Reply publicly | yes | yes (top-level comments only, not hidden ones) | yes |
| Private message the commenter | yes, once per comment, within 7 days | yes, same rules | **no** (TikTok has no way to do this) |
| Hide / unhide | yes | yes | yes |
| Delete | yes | yes | **own comments only** (hide others instead) |

Comments arrive by webhook (Meta and TikTok), so new ones show up within
seconds (Meta) or about five minutes (TikTok). TikTok also has a
**Fetch comments now** button as a safety net.

You can try every screen before connecting anything: **Settings → Channels →
(Messenger, Instagram or TikTok) → Add sample comments**. Sample comments are
labelled *Sample*; replying to or moderating them is simulated and never
touches a platform.

## Facebook and Instagram

Uses the Messenger / Instagram connection from
[messenger-instagram-setup.md](messenger-instagram-setup.md) and the same
Meta app. Comments need extra permissions, so it is opt-in:

1. In the Meta developer dashboard, add these permissions to your app and get
   them approved through App Review (they only work for people with a role on
   the app until then):
   - Facebook: `pages_manage_engagement`, `pages_read_user_content`,
     `pages_manage_metadata`
   - Instagram: `instagram_manage_comments`, `pages_manage_metadata`
2. In the dashboard, on **Webhooks**, subscribe the `page` object to the
   `feed` field and the `instagram` object to `comments` and `live_comments`.
   The callback URLs are the same ones the DM channels already use
   (`/api/messenger/webhook` and `/api/instagram/webhook`).
3. In **Settings → Channels → Messenger** (or **Instagram**), use
   **Allow comments (reconnect)** to sign in again with the extra permissions,
   then **Turn on comments** to subscribe the Page to comment events.

Notes:

- Comments on **ads** arrive on the same Facebook `feed` webhook. They are
  labelled *Ad post* (an unpublished "dark" post). Instagram ad comments have
  no webhook, so they are not included.
- A private reply starts a normal Messenger / Instagram conversation: the
  commenter becomes (or is matched to) a contact, your message is filed in
  their chat, and their answer arrives there.

## TikTok

Needs an approved TikTok developer app with access to the **Accounts API**
(TikTok API for Business). Since March 2026 that requires TikTok's access
application form; plan for review time.

1. On the server, set `TIKTOK_APP_ID` and `TIKTOK_APP_SECRET` (see
   `.env.local.example`) and restart. If the developer portal shows an
   authorization URL for your app, put it in `TIKTOK_AUTH_URL`.
2. In the TikTok developer portal, add the **Redirect URL** shown in
   **Settings → Channels → TikTok** (it must end with a slash).
3. **Settings → Channels → TikTok → Connect TikTok**, and sign in with the
   TikTok account whose videos you want.
4. Press **Register webhook with TikTok** once (it is per developer app, not
   per account). Without it, comments only arrive when you press
   **Fetch comments now**.

Notes:

- TikTok access tokens last one day; the CRM refreshes them automatically and
  asks you to reconnect if the yearly refresh token expires or is revoked.
- TikTok sends only the comment text and an anonymous id; the commenter's name
  and the video's details are fetched with a follow-up call.
- Comments on **TikTok ads** (a separate Marketing API) are not included yet.

## What is verified

The Facebook, Instagram and TikTok code follows each platform's published
documentation and is covered by unit tests (parsing, signature checks,
capability rules, ingest, actions). It has **not** yet been run against live
accounts. The first real test should check: that a Facebook `from.id` matches
the person's Messenger id, that Instagram edit/delete events arrive, and which
TikTok scopes each write endpoint needs.
