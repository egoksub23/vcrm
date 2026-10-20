# Open in Vircle Back Office (Inbox)

A customer care agent who is talking to a parent can open that parent's record in the Vircle Back Office (BO2) without leaving the Inbox. This page is for the person who runs the server.

## What the agent sees

- On a wide screen (extra large, 1280 px and up) there is a narrow rail at the far right of the Inbox, beside the Customer information panel. It shows one icon-only button, **Open in Vircle Back Office**. A small chevron at the top of the rail expands it to show the label and the line "Open this parent's record". The choice (minimised or expanded) is remembered in that browser only. The rail is there for every conversation and stays put while the agent switches between the Contact and Knowledge tabs.
- On narrower screens (phones, tablets, small laptops) the rail is not drawn. The same button sits in the conversation header instead.
- Clicking the button slides a panel in from the right across the chat (full width on a phone; otherwise **60% of the screen**, never narrower than 360 px). The panel is titled **Vircle Back Office - Customer care** and holds a **Find an app user** form:
  - a phone box, **prefilled with the contact's phone number exactly as Halo holds it** (editable; empty if the contact has none, such as a web chat visitor);
  - **Search** (Enter works too);
  - **Open in new tab**, always available once a number is in the box;
  - **Find another user**, which clears the form.
- What **Search** does depends on `BACK_OFFICE_EMBED` (below): it opens the Back Office in a new tab (default), or shows it inside the panel.
- The header has three buttons, which differ in what they keep:
  - **Minimise** puts the panel away into the rail. The Back Office page stays loaded (hidden) and the rail button, which now shows a dot, brings it back exactly as it was: same search, same tab, nothing reloaded. **Esc** and a click outside the panel do the same while a search is on screen. A panel left minimised for **ten minutes** is closed, and moving to another conversation closes it at once, so one parent's record is never left loaded behind another parent's chat.
  - **Full screen / Back to the usual size** (not shown on a phone, where the panel already fills the screen) toggles between 60% of the screen and all of it.
  - **Close** shuts the panel and unloads the frame, so nothing keeps loading in the background. **Esc** does this on the form when there is no search to keep. Focus returns to the button that opened it.

Signing in is separate. Halo and the Back Office use different identity providers, so the agent signs in to the Back Office on its own. An agent without the Back Office **Customer Care** page sees "access denied" there. That is intended.

## Settings (server only)

Both are read when the server runs. Put them in `.env.local` and restart the container; no rebuild is needed (see `docs/docker.md`).

| Variable | Meaning |
|---|---|
| `BACK_OFFICE_USER_URL` | The address of the Back Office user page. Production: `https://v2.vircle.net/app-user-details-b` (the Halo at halo.vircle.tech uses this one since 20 Oct 2026). UAT: `https://v2-uat.vircle.net/app-user-details-b`. It must be a valid **https** URL (no user name or password in it). Any query string or `#fragment` is removed. If it is unset or not valid, the feature is hidden: no rail, no header button. |
| `BACK_OFFICE_EMBED` | Optional. `true` or `1` shows the Back Office inside the panel (a frame). Anything else, including unset, is off: Search opens a new tab. Has no effect without a valid `BACK_OFFICE_USER_URL`. |

The browser learns both from `GET /api/account/back-office-link`, which answers `{ "baseUrl": string | null, "embed": boolean }` and nothing else. It needs the **Inbox menu** permission (`menu.inbox`), is workspace-scoped through the signed-in session and is never cached.

## The link

For a phone number the browser builds:

```
<BACK_OFFICE_USER_URL>#q=<encodeURIComponent(phone)>
```

For example `+60123456789` becomes `https://v2-uat.vircle.net/app-user-details-b#q=%2B60123456789`, and `0123456789` becomes `...#q=0123456789`.

Rules agreed with the Back Office team:

- The number goes after `#q=`, not `?q=`. A fragment is never sent to a server, so the number stays out of server logs and the Referer header. The Back Office reads it and removes it from the address bar.
- The value is URL-encoded (a leading `+` is `%2B`).
- Either format works (`+60123456789` or `0123456789`). Halo sends whatever it holds and does not normalise it. The only change is trimming spaces around it.
- No name is passed: the phone number is the reliable key.
- In a new tab the link opens with `target="_blank"` and `rel="noopener noreferrer"`, so the Back Office gets no opener and no Referer.

The link is built in the browser (`src/lib/back-office/link.ts`). **The phone number never goes to Halo's server**: the route above is asked for the address only. Halo does not log the number or send it to analytics.

## Showing the Back Office inside Halo (`BACK_OFFICE_EMBED`)

Leave it **off** unless the Back Office team has confirmed both of these:

1. The Back Office allows being shown in a frame by the Halo address (its `Content-Security-Policy: frame-ancestors` and any `X-Frame-Options` must permit your Halo origin).
2. Sign-in works inside a frame. Identity providers often refuse to load in a frame, and browsers may block the Back Office's cookies when it is framed by another site. If either fails, the agent sees an empty or error page in the panel.

The frame is sandboxed (`allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox`), sends no Referer and has a title. Under the frame the panel always says: "If the page does not appear or asks you to sign in, use Open in new tab." The new-tab button is always there as the way out.

### Content-Security-Policy

Halo's Content-Security-Policy is currently **Report-Only**. If `BACK_OFFICE_USER_URL` is set **when the image is built** (`next build`), the policy's `frame-src` allows `'self'` and the Back Office origin. Next.js computes response headers at build time, so this part does **not** follow a change made at runtime. The Dockerfile does not pass `BACK_OFFICE_USER_URL` into the build today, so before the policy is switched to enforcing, add it as a build argument (or add the origin to `frame-src` by hand). Until then a framed Back Office is reported in the browser console, not blocked. New-tab mode needs no policy change.

### Asking the Back Office for a body-only page (`embed=1`)

The Back Office page has its own menu and header, which take a third of a narrow panel. Halo cannot remove them: it is another site's page. When it shows the page in the panel, Halo therefore adds a hint to the address, after the phone:

```
<BACK_OFFICE_USER_URL>#q=<encodeURIComponent(phone)>&embed=1
```

"Open in new tab" never carries it. **The Back Office does not act on it yet** (as of 20 Oct 2026 its app reads only `q`, from the fragment or the query string, and ignores anything else, so the hint is harmless). What the Back Office team would add: when `embed=1` is present, in the fragment or the query string, do not draw the sidebar and the top header on that page, and let the page use the full width of its window. The user's sign-in, the `q` search and everything below the header stay as they are. A single flag on the app shell is all it takes; no change is needed in Halo when it ships.

## Checking it

1. Set `BACK_OFFICE_USER_URL`, restart, open the Inbox on a wide screen: the rail appears at the far right. Unset it and restart: it is gone.
2. Open a conversation with a contact that has a phone number, click the icon: the panel opens with the number in the box. **Search** opens the Back Office with `#q=...` in the address (the Back Office then clears it).
3. Open a web chat visitor (no phone): the box is empty and the panel says to type a number.
4. Narrow the window below 1280 px: the rail goes and the button appears in the chat header.

Not verified by automated tests (no browser in the test setup): the slide-in itself, focus moving into the panel and back, Esc, the real Back Office loading in the frame, and dark mode. Check those by hand once on UAT.
