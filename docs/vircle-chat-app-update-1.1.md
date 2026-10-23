# Vircle Chat: what changed on 23 October 2026, and what to do about it

For the front-end engineer (and their coding agent). It answers the three points in your feedback. The full specification is still
`vircle-chat-app-build-spec.md`; this note only says what is new and what you must do. Everything here is in the refreshed kit
(`vircle-chat-app-kit.zip`).

## 1. Install the new library: `@vircle/chat-client` 1.1.0

```bash
npm install ./library/vircle-chat-client-1.1.0.tgz      # replaces 1.0.0; nothing else in the library changed
```

New in 1.1.0 (the README in `library/` has the details):

| Change | Use |
| --- | --- |
| `chat.fetchHistory({ before: { sentAt, serverId? }, limit?, notBefore? })` | One page of **older** messages from Halo: `{ messages, more, end }`. Oldest first, `seq` is null, `id === serverId`. Stateless: nothing is added to the library's list, nothing counts as unread, no receipt is sent. Your engine stores the page and prepends it (build spec 5.4, 8.4, task **T19**). |
| `chat.getMediaUrl(message)` | Now also accepts the message itself. Use it to renew the link of a **history** message (it is not in the library's list). |
| `ChatError.retryAfterSeconds` | Set on `rate_limited` and `history_unavailable`. |
| `historyTimeoutMs` option | How long to wait for a page. Default 20 s (Halo is asked, so it can take a few seconds). |

Errors `fetchHistory` rejects with (`ChatError.code`): `offline`, `history_unavailable` (retry later), `rate_limited` (10 pages a minute),
`history_disabled` (stop asking: Halo has no history for the workspace, or the gateway is an older one), `bad_request`, `timeout`.

Things to know:

* **Phase B is no longer blocked.** Build T19 now. Keep the check `typeof chat.fetchHistory === 'function'` so a 1.0.0 library still works as Phase A.
* Halo supplies up to **90 days** (a setting per workspace). The last page says `end: 'window'` when older messages exist beyond that, `'start'` when the
  conversation really begins there. After the user pressed Clear chat, any end reads as `'cleared'` (spec 8.4).
* The first time the user **opens an old photo or voice note** takes a moment (the gateway fetches it from Halo, then keeps it for a day). A history message's
  `media.fileName` may be empty and `sizeBytes` 0. Never store `media.url`; renew with `getMediaUrl(message)`.
* Do not send `delivered`/`read` for history, do not count it as unread, do not show a notification for it.

## 2. The deep link is a universal link: `https://app.vircle.com/chat/{conversation_id}`

This is the link every chat alert carries. A tap only opens the **chat page** (instead of the browser) when the platform setup below is done. It is yours and
Vircle's to do; the gateway cannot do it.

* **Routing** (spec R-CONN-6): accept `https://app.vircle.com/chat/<id>`; the older `vircle://chat/<id>` is still understood. Navigate to the chat page, then
  call `reconnectNow()`.

```ts
const m = /^(?:https:\/\/app\.vircle\.com|vircle:\/)\/chat\/([\w-]+)/.exec(url)
```

* **iOS**: add the Associated Domains capability `applinks:app.vircle.com`, and serve this file at
  `https://app.vircle.com/.well-known/apple-app-site-association` (no extension, `Content-Type: application/json`, no redirect):

```json
{ "applinks": { "details": [ { "appIDs": ["<TEAMID>.<bundle id>"], "components": [ { "/": "/chat/*" } ] } ] } }
```

* **Android**: an intent filter on the main activity, and the file `https://app.vircle.com/.well-known/assetlinks.json`:

```xml
<intent-filter android:autoVerify="true">
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="https" android:host="app.vircle.com" android:pathPrefix="/chat/" />
</intent-filter>
```

```json
[ { "relation": ["delegate_permission/common.handle_all_urls"],
    "target": { "namespace": "android_app", "package_name": "<package>", "sha256_cert_fingerprints": ["<release key SHA-256>", "<debug key SHA-256 for testing>"] } } ]
```

* **Huawei**: the same Android App Link. Test on a device without Google services; if the link does not verify there, register it with Huawei App Linking
  (AppGallery Connect). Please tell us which it is.
* If `app.vircle.com/chat/...` is opened where the app is not installed it lands on a web page: that page is Vircle's to provide.
* Test with `adb shell am start -a android.intent.action.VIEW -d "https://app.vircle.com/chat/c_test"` and `xcrun simctl openurl booted https://app.vircle.com/chat/c_test`.

## 3. The chat-alert marker in the push payload

The gateway puts this in the alert's `data` (all values are strings):

```json
{ "notification_type": "01", "chat_alert": "1", "conversation_id": "c_9f2a", "deep_link": "https://app.vircle.com/chat/c_9f2a" }
```

`notification_type` stays `"01"` like every other Vircle alert. **`chat_alert` is the marker**: collapse `PushRoutingPort.isChatAlert` to
`data.chat_alert === '1'` and delete the other candidate markers. If the push API changes the field name or drops custom fields, that is a change in one place
(the port); tell us and we change the gateway.

**Not confirmed yet**: the Vircle push team must confirm their API forwards custom string fields unchanged. Until the real push adapter exists the gateway only
records alerts (the simulator's **Push inbox** tab shows them with this data), so you cannot receive a real one yet.

## 4. Test it without a server

The simulator in the kit now has a made-up older conversation behind `fetchHistory`: 190 messages, one every 14 hours. **154 fall inside the 90-day window**
(four pages of 50, the last one ends with `end: 'window'`); the rest lie beyond it. Photos are not part of it (a file request answers "not found").

```bash
cd simulator && npm install && npm run sim        # Node 24.22.1 or later (22.23.4 or later also works)
open http://localhost:8090/launch
```

Page through it with your engine: 30 at a time from the newest, check the cursor (no repeats, none missed), the `window` line, Clear chat with `notBefore`, and the
errors (`history_unavailable` and `rate_limited` can be provoked by stopping the simulator's fake Halo or asking 11 times in a minute).

## 5. What is not ready, and what we need from you

| Item | State |
| --- | --- |
| Real Halo history | Built; goes live when the Halo team deploys version 0.100.0 and the gateway is redeployed. Until then the live chat answers `history_disabled` or an error: expect it in production only after they tell you |
| Sandbox Halo workspace / sandbox sessions key | Does not exist. Develop against the simulator |
| Real push alerts | Waiting on the Vircle push API details |
| Backend session endpoint (`POST /chat/session`) | Vircle's backend developer |

Please tell us: (1) the Huawei App Link answer, (2) any field you need in a history message that is not there, (3) whether `apple-app-site-association` and
`assetlinks.json` are in place on `app.vircle.com`.
