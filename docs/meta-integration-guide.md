# Connecting Facebook, Messenger and Instagram to Vircle CRM

A step-by-step guide for anyone setting up the Meta side (Facebook Page chats,
Instagram DMs, and public comments on Facebook and Instagram posts) for a Vircle
CRM deployment. It is written from a real set-up, including every error we hit
and what fixed it.

- Messenger and Instagram DMs: a two-way chat in **Inbox → Chats**.
- Facebook and Instagram comments: **Inbox → Comments** (reply publicly, private
  reply by DM, hide, delete, mark resolved).
- All of it runs on **one Meta app**, the same one WhatsApp uses.

Meta renames things in its dashboard often. Menu names below match the dashboard
as of September 2026; if a name differs, look for the closest one.

**Confirmed working live:** Messenger DMs, Facebook comments arriving with public
reply and delete, and Instagram comments arriving with public reply. Not yet
confirmed live: private reply on either platform, hide and unhide, and delete on
Instagram.

---

## 1. How it fits together

```
Customer on Facebook / Instagram
        │  message or comment
        ▼
   Meta (Graph API)  ── webhook ──►  https://<your-domain>/api/messenger/webhook
                                     https://<your-domain>/api/instagram/webhook
                                              │
                                              ▼
                                       Vircle CRM (Supabase)
                                        Inbox → Chats / Comments
        ▲
        │  replies, moderation (Graph API, using the Page access token)
        └─────────────────────────────────────────────────────────
```

Three separate things must all be true before anything arrives. Most problems
are one of these three missing:

| # | What | Where you set it |
|---|---|---|
| 1 | The Meta **app has the permission** | Meta dashboard → Use cases → Permissions and features |
| 2 | Meta **knows where to send events** and which kinds | Meta dashboard → Webhooks (URL, verify token, subscribed fields) |
| 3 | Your **Page is connected and subscribed** in the CRM | CRM → Settings → Channels → Messenger / Instagram |

The CRM uses **Instagram API with Facebook Login**: the admin signs in with
Facebook and picks a Facebook Page that has an Instagram professional account
linked. It does **not** use "Instagram API with Instagram login" (the other tab
you will see in Meta, with its own separate Instagram App ID and `instagram_business_*`
permission names). Ignore that tab and that App ID.

---

## 2. Before you start

You need:

- A **Facebook Page** you administer (not a personal profile).
- For Instagram: an Instagram **professional** (business or creator) account
  **linked to that Facebook Page**. Personal Instagram accounts cannot use the API.
- A Facebook account that is an **admin of the Meta app** (or has a developer or
  tester role on it).
- A deployed Vircle CRM on a public **HTTPS** domain. Meta cannot call
  `localhost`.
- On the server: `META_APP_ID`, `META_APP_SECRET`, and `NEXT_PUBLIC_SITE_URL`
  (your exact public URL, for example `https://crm.example.com`, no trailing
  slash). These are the same values WhatsApp already uses. If `NEXT_PUBLIC_SITE_URL`
  does not exactly match the domain you register in Meta, the connect step fails.
- Account admin rights in the CRM (only admins can connect channels).

---

## 3. Meta developer dashboard set-up (once per app)

Open <https://developers.facebook.com/apps>, choose your app.

### 3.1 Add the use cases

On the app **Dashboard**, the "Use cases" list needs these. Add missing ones with
**Add use cases** (top right; use the category filters on the left of the pop-up).

| Use case | Filter category | Gives you |
|---|---|---|
| **Engage with customers on Messenger from Meta** | Business messaging | Messenger DMs (`pages_messaging`), `pages_manage_metadata`, `pages_read_engagement`, `pages_show_list`, `business_management` |
| **Manage messaging & content on Instagram** | Business messaging | Instagram DMs and comments (Facebook-login flavour: `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`) |
| **Manage everything on your Page** | Content management | `pages_manage_engagement` and `pages_read_user_content`, which Facebook comments need and which are **not** in the Messenger use case |

> **The single most common mistake.** Facebook comments need `pages_manage_engagement`
> and `pages_read_user_content`. They do not appear in the Messenger use case. If
> you skip "Manage everything on your Page", the CRM's **Allow comments** button
> fails with *"Invalid Scopes: pages_manage_engagement, pages_read_user_content"*.

### 3.2 Add each permission to the app

For every use case, open **Customize → Permissions and features** and press **Add**
next to each permission below so its status reads **Ready for testing**:

| Permission | Needed for |
|---|---|
| `pages_show_list` | listing your Pages when connecting |
| `pages_messaging` | Messenger DMs |
| `pages_read_engagement` | reading Page content and profile info |
| `pages_manage_metadata` | subscribing the Page to webhooks |
| `business_management` | Page and business asset access |
| `instagram_basic` | reading the linked Instagram account |
| `instagram_manage_messages` | Instagram DMs |
| `pages_manage_engagement` | Facebook comments: reply, hide, delete |
| `pages_read_user_content` | Facebook comments: read what people wrote |
| `instagram_manage_comments` | Instagram comments: read, reply, hide, delete |

Instagram tip: open **Manage messaging & content on Instagram → API setup with
Facebook login** (not "with Instagram login") and use its **Permissions and
features**. Use ctrl+F on that page to find `instagram_manage_comments`.

### 3.3 App domain and redirect URIs

1. **App settings → Basic → App domains:** add your bare domain
   (`crm.example.com`, no `https://`, no path).
2. **Facebook Login for Business → Settings → Valid OAuth Redirect URIs:** add both,
   with your own domain:
   ```
   https://crm.example.com/api/account/channels/messenger/oauth/callback
   https://crm.example.com/api/account/channels/instagram/oauth/callback
   ```

These are two separate settings. Meta's error for a missing App domain ("Can't load
URL: the domain of this URL isn't included in the app's domains") does not say which
one is wrong, so do both.

### 3.4 Webhooks

Webhooks are configured per **object** (User, Page, Instagram, …). Reach them from a
use case's **Webhooks** menu item. Pick the object in the column on the left.

**Page object** (Messenger and Facebook comments)

| Setting | Value |
|---|---|
| Callback URL | `https://crm.example.com/api/messenger/webhook` |
| Verify token | any string you make up; use the **same** string in the CRM (see 4.1) |
| Fields to subscribe | `messages` (DMs) and **`feed`** (Facebook comments, including ad comments) |

**Instagram object** (Instagram DMs and comments)

| Setting | Value |
|---|---|
| Callback URL | `https://crm.example.com/api/instagram/webhook` |
| Verify token | any string; same one in the CRM |
| Fields to subscribe | `messages` (DMs) and **`comments`** and **`live_comments`** |

Press **Verify and save** after entering the URL and token. Then switch on the
individual fields. A green tick on the URL means Meta can reach your server. It does
**not** mean events are being sent. Fields must also be switched on, and the Page must
be connected (section 4).

Leave the Permissions, User, Application and other objects alone. Nothing needs a
callback URL there.

Use the newest API version in each field's dropdown, the same for all fields on an
object (Meta says so at the top of the page).

---

## 4. CRM set-up

### 4.1 Connect Messenger

1. **Settings → Channels → Messenger.**
2. In **Webhook setup**, type your verify token and press **Save**. It must match
   what you entered in Meta (section 3.4). Do this before pressing "Verify and save"
   in Meta.
3. Press **Connect with Facebook**, sign in, approve the permissions, and choose the
   Page if you administer more than one.
4. The panel shows *Connected, <Page name>*.

### 4.2 Connect Instagram

1. **Settings → Channels → Instagram.** Same webhook verify-token step.
2. **Connect with Facebook.** Choose the Page that has the linked Instagram
   professional account. It fails with a clear message if the Page has none.
3. The panel shows the Instagram username.

### 4.3 Turn on comments (opt-in, per channel)

Comment permissions are asked for separately so workspaces that only want DMs are
never blocked by a permission Meta has not approved.

1. On the channel page find the **Facebook comments** (or **Instagram comments**) card.
2. Press **Allow comments (reconnect)**. Facebook opens again; pick the same Page and
   **approve every permission on the list**, including the comment ones. If it shows
   *Invalid Scopes*, the permission is missing in Meta (section 3.1 and 3.2).
3. Press **Turn on comments**. The card changes to *On since <date>*.
   - Facebook: the CRM subscribes your Page to `feed`.
   - Instagram: the CRM only checks that `instagram_manage_comments` was granted. The
     `comments` and `live_comments` fields are app-level (section 3.4), not Page fields;
     Meta rejects them as Page fields.

New comments appear in **Inbox → Comments** within seconds.

### 4.4 Try it without going live

**Settings → Channels → Add sample comments** puts made-up English, Malay and Chinese
comments in the Comments tab. Replies and moderation on them are simulated and never
reach a platform. Use **Remove sample comments** to clear them.

---

## 5. Testing checklist

Do these in order. Stop at the first failure and go to section 7.

- [ ] Send a Messenger message to the Page from an account with a role on the app.
      It shows in **Chats**; reply from the CRM and it arrives in Messenger.
- [ ] Send an Instagram DM to the linked account. Same check.
- [ ] Comment on a Facebook Page post from a test account. It shows in **Comments**.
- [ ] Comment on an Instagram post. It shows in **Comments**.
- [ ] **Reply publicly.** The reply appears under the comment on the platform.
- [ ] **Private message.** A DM reaches the commenter and the chat appears in **Chats**
      (Facebook and Instagram allow one private reply per comment, within 7 days).
- [ ] **Hide**, then **unhide**. Confirm on the platform.
- [ ] **Delete** on a test comment (admins only in the CRM).

While the app is in **Standard access** (before App Review), only people who have a
role on the app (admin, developer, tester) and the Page owner reach the CRM.

---

## 6. Going live for the public (App Review)

Until Meta approves **Advanced access**, comments and messages from ordinary customers
do not reach the CRM. You can run the full set-up and testing above with role-holders
before then.

Permissions to request Advanced access for:
`pages_messaging`, `pages_read_engagement`, `pages_show_list`, `business_management`,
`pages_manage_metadata`, `pages_manage_engagement`, `pages_read_user_content`,
`instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`.

What Meta normally asks for (requirements can change; check the current App Review
page):

- **Business Verification** of the business that owns the app.
- For each permission: a written use case ("agents reply to customer messages and
  comments in a shared inbox") and a **screencast** showing the feature working end to
  end in the CRM, including the login and permission screens.
- A privacy policy URL and a working data-deletion URL or instructions.
- The app switched to **Live** mode. (This app is already Published.)

Messenger and Instagram DMs also follow Meta's 24-hour rule: after a customer's last
message you can reply freely for 24 hours; after that, only within Meta's allowed
message tags.

---

## 7. Troubleshooting

| What you see | Cause | Fix |
|---|---|---|
| **Allow comments** opens Facebook and shows *"This content isn't available right now. Invalid Scopes: pages_manage_engagement, pages_read_user_content"* | The app has no use case that provides those permissions | Add the **Manage everything on your Page** use case, then add both permissions (3.1, 3.2) |
| **Turn on comments** on Instagram shows *"(#100) Param subscribed_fields[…] must be one of {feed, mention, …} got \"comments\""* | Old CRM version tried to subscribe the Page to `comments`, which Meta only allows as an app-level Instagram field | Update the CRM to 0.34.2 or later. Make sure `comments` and `live_comments` are on the **Instagram** webhook object in Meta (3.4) |
| Messenger works but Facebook comments never arrive | `feed` is not subscribed, or **Turn on comments** never succeeded | Switch `feed` on for the **Page** object (3.4), press **Allow comments** then **Turn on comments** (4.3). The card must say *On since…* |
| Turn on comments says a permission was not granted | The Facebook pop-up was approved without the comment permissions | Repeat **Allow comments (reconnect)** and tick everything |
| Callback URL shows verified but nothing arrives | Verified and subscribed are different. Fields are off, or the Page is not connected | Switch on the fields for the correct object; reconnect in the CRM |
| **Verify and save** fails in Meta | The verify token in Meta differs from the one saved in the CRM, or the CRM cannot be reached | Save the token in the CRM first, use the exact same string; check the CRM is reachable from the internet (an HTTPS error or timeout means Meta cannot reach it either) |
| *"Can't load URL: the domain of this URL isn't included in the app's domains"* | The App domain is missing | Add your bare domain under App settings → Basic (3.3) |
| Redirect error after signing in | Redirect URI not registered, or `NEXT_PUBLIC_SITE_URL` differs from the domain | Register both callback URLs exactly (3.3); fix the env var |
| Comments from the test account arrive but not from other people | App is in Standard access | Complete App Review (section 6), or add the person under **App roles** |
| Instagram connect fails with "no Instagram account" | The Page has no linked Instagram professional account | Link it in Instagram → Settings → Account type and tools / Page settings |
| Replies stop working weeks later, panel shows **Reconnect** | The token expired or was revoked (Meta error code 190) | Press **Reconnect** and sign in again |
| The Meta **Test** button on a webhook field sends a sample and nothing appears | Meta's samples use made-up IDs that match no connected account | Expected. Test with a real comment instead |
| Your own replies show up twice in Chats | (Guarded against.) Meta echoes Page-sent messages back; the CRM ignores echoes | If you ever see duplicates, report it with the time and message |

### Quick health check

- CRM **Settings → Channels →** channel card shows **Connected** and, for comments,
  **On since…**.
- Meta webhook page: callback URL saved, right fields switched on for the right object.
- A real comment from a role-holder appears in **Inbox → Comments** within about 10
  seconds. If not, press the refresh button in the Comments tab.

---

## 8. Reference

### Webhook URLs

| Purpose | URL |
|---|---|
| Messenger DMs + Facebook comments (Page object) | `https://<domain>/api/messenger/webhook` |
| Instagram DMs + comments (Instagram object) | `https://<domain>/api/instagram/webhook` |
| OAuth redirect (Messenger) | `https://<domain>/api/account/channels/messenger/oauth/callback` |
| OAuth redirect (Instagram) | `https://<domain>/api/account/channels/instagram/oauth/callback` |

### Which webhook field carries what

| Field | Object | Carries |
|---|---|---|
| `messages` | Page | Messenger DMs |
| `feed` | Page | Facebook post comments (organic and ad), including deletions and hides |
| `messages` | Instagram | Instagram DMs |
| `comments` | Instagram | Instagram post comments |
| `live_comments` | Instagram | Instagram Live comments |

### Platform limits the CRM respects

- **Private reply:** one DM per comment, within 7 days of the comment, Facebook and
  Instagram only. It starts a normal chat with the commenter.
- **Instagram:** cannot reply to a reply; cannot reply to a hidden comment.
- **Facebook ad comments** arrive on the `feed` webhook and are labelled *Ad post*.
  Instagram ad comments have no webhook and are not included.
- **Messenger and Instagram** support plain text and media. Templates, buttons and
  lists (automation steps `send_template`, `send_buttons`, `send_list`) are
  WhatsApp-only.

### Environment variables

| Variable | Meaning |
|---|---|
| `META_APP_ID`, `META_APP_SECRET` | The one Meta app used for WhatsApp, Messenger and Instagram. Do **not** use the separate Instagram App ID |
| `NEXT_PUBLIC_SITE_URL` | Exact public URL of the CRM, used to build the OAuth redirect |

### What is stored

The Page access token is stored encrypted. Channel rows live in `messenger_config` and
`instagram_config`; comments in `comments`, `comment_posts`, `comment_actions`
(audit trail) and `comment_webhook_events` (duplicate protection).

### Related documents

- [messenger-instagram-setup.md](messenger-instagram-setup.md): the DM set-up in brief
- [comments-setup.md](comments-setup.md): comments plus TikTok
- `docs/multi-waba.md`: shared Meta app and verify tokens
