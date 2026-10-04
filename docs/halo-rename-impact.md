# Renaming crm.vircle.tech to halo.vircle.tech: impact report

Prepared 3 October 2026 from the code, the documentation and a read-only look at the production database. Nothing has
been changed. Use it to decide, schedule and later measure the change.

## Status (4 October 2026)

Done: DNS, nginx and one certificate for both names; `NEXT_PUBLIC_SITE_URL` and `ALLOWED_INVITE_HOSTS` set and rebuilt; Supabase
redirect list and Site URL; redirect URIs added at Meta and Microsoft; chat gateway pointed at the new address (outbox clear);
Microsoft 365 mail subscription recreated (expires 7 Oct, renews nightly); Messenger, Instagram and Vircle Chat tested end to end.
Cron jobs call `localhost:3000`, so they never needed changing.

Still open: the WhatsApp callback in Meta (needs a fresh access token and verify token), confirming the Messenger and Instagram
callbacks are on the new host, updating web-widget embeds and the Vircle app's WebView, the Atlassian callback (no webhooks exist),
nginx logging by host to watch the old address, and after 30 days a redirect for browser pages and retirement of `crm`.

## 1. The short version

* **The code needs no change.** The app never hard-codes its own host. It builds its own links from the
  `NEXT_PUBLIC_SITE_URL` setting when that is set, and from the address the request arrived on when it is not. A rebuild
  with the new setting (your usual redeploy command does it) is enough.
* **The work is outside the code:** about **ten external registrations** hold the old address (Meta, Microsoft, Atlassian,
  Supabase sign-in, the chat gateway, the server's scheduled jobs, DNS and TLS), plus **whoever embeds the web widget** and
  **six people who will have to sign in again**.
* **Four things fail silently** if forgotten, because the provider keeps calling the old address and nobody is told:
  Meta's webhooks (WhatsApp, Messenger, Instagram), the Microsoft 365 mailbox subscription, any website or app that loads
  the chat widget from the old address, and the chat gateway's events to Halo.
* **The safe way is two addresses for a while:** make the new one work first, switch everything over, and keep the old one
  answering all machine traffic (webhooks, the widget, the API) for at least 30 days. Then the change is reversible in minutes
  and the old address tells you, by its own access log, what you forgot.

## 2. How Halo decides its own address

| Where | Rule |
| --- | --- |
| Invite links, OAuth redirects (Meta, Microsoft, Google, Jira, TikTok), Microsoft mailbox notifications, the Jira webhook address, the Vircle Chat webhook address shown in Settings | `NEXT_PUBLIC_SITE_URL` if set, else the `X-Forwarded-Host` header, else `Host`. If `ALLOWED_INVITE_HOSTS` is set, the host must be in that list. |
| Sign-in, password reset, sign-up confirmation | The browser's own address (`window.location.origin`). |
| The web widget | Loads from, and calls the API of, whichever address its `<script>` tag names. |
| `NEXT_PUBLIC_SITE_URL` | Baked in at **build** time: changing it needs a rebuild. |

A search of the whole repository finds the old host only in the documents I wrote for the chat gateway.

## 3. What exists in production today (3 October 2026)

| Item | Count | Note |
| --- | --- | --- |
| Workspaces / people | 1 / 6 | Six sign-ins to redo. |
| WhatsApp, Messenger, Instagram, Microsoft 365 email | 1 each | Each has an external registration to move. |
| Web widget | 1, enabled | The list of allowed websites is empty, so I cannot tell from the database where it is embedded. |
| Vircle Chat | 1 | The gateway holds Halo's webhook address. |
| Jira connection | 1 | **0 webhooks registered**, so there is nothing to move today. |
| Gmail, TikTok, API keys, outgoing webhooks | 0 | Nothing to change. |
| Stored references to `crm.vircle.tech` anywhere in the database | 3 rows | One team-chat message and its link preview. Not structural. |

Inbound customer messages, the baseline to compare against afterwards:

| Channel | Last 24 h | Last 7 days | Last 30 days | All time |
| --- | --- | --- | --- | --- |
| Email | 0 | 0 | 1,066 | 1,129 |
| Messenger | 3 | 3 | 12 | 12 |
| Web widget | 0 | 5 | 16 | 16 |
| WhatsApp | 0 | 0 | 25 | 25 |
| Vircle Chat | 2 | 2 | 2 | 2 |

## 4. Two things I found that are not caused by the rename, but matter before it

1. **Only 4 of the 9 scheduled jobs have ever reported.** The Platform console's Background jobs card is fed by a heartbeat
   each job records. Running (and recent): automations, flows, conversation SLA, ticket SLA. **No heartbeat at all** from:
   incident escalation, the Jira job queue, the stuck-send sweep and the **Microsoft 365 mailbox renewal**. The mailbox
   subscription expires on **5 October 2026, 11:11 UTC**. If it is not renewed, inbound email stops. (Opening Halo in a browser
   can also renew it, which is probably what kept it alive so far, but that is not something to rely on.) The crontab on the
   server needs the missing lines (section 8, step 0). Do this first, so the crontab is only edited once more for the rename.
2. **Email inbound is zero for the last 7 days** (1,066 in the last 30). It may simply be quiet, or an earlier bulk import. Check
   before the rename, otherwise a silent mailbox afterwards cannot be told apart from a broken one.

## 5. Everything that holds the old address

"Silent" means the failure is not reported anywhere if you forget it.

| # | System | What holds the old address | What to do | Silent? | How to check |
| --- | --- | --- | --- | --- | --- |
| 1 | DNS | `crm.vircle.tech` A record | Add `halo.vircle.tech` A to 187.127.105.156. Keep the old one. | no | `nslookup halo.vircle.tech` |
| 2 | nginx and TLS | The `crm` site block and its certificate | Serve both names from the same upstream; `certbot --nginx -d halo.vircle.tech`. | no | Browser shows a valid certificate on both. |
| 3 | Halo settings on the server | `NEXT_PUBLIC_SITE_URL` (if set), `ALLOWED_INVITE_HOSTS` (if set) in `/opt/wacrm/.env.local` | Set both to the new host, then redeploy (rebuild). | no | Settings, Channels, Vircle Chat shows the new webhook address. |
| 4 | Supabase sign-in | Site URL and the allowed redirect list | Add `https://halo.vircle.tech/**`, then switch Site URL. Check the email templates. Google/Microsoft single sign-on uses Supabase's own callback, which does not change. | no (sign-in fails loudly) | Password reset and an invite link, end to end. |
| 5 | Meta: WhatsApp | Callback URL in the app: WhatsApp, Configuration | Set `https://halo.vircle.tech/api/whatsapp/webhook`. Meta calls the new address to verify it, so the new host must already be live. | **yes** | Send a WhatsApp message in; watch the inbox. |
| 6 | Meta: Messenger and Instagram | Webhook callback URLs; Facebook Login valid OAuth redirect URIs; App Domains | Add the new redirect URIs first (additive), add the new domain to App Domains, then switch the webhook callbacks. | **yes** | Message the page and the Instagram account; reconnect test. |
| 7 | Microsoft 365 email | (a) The Entra app's redirect URI. (b) The change-notification subscription at Microsoft, which **keeps the address it was created with**: renewals extend it but never change it. | (a) Add the new redirect URI. (b) After the switch, clear the subscription id so the renewal job creates a new one, and keep the old host answering `/api/email/webhook` until the old subscription expires (up to 3 days). | **yes** | `email_config.subscription_expires_at` moves; a test mail arrives. |
| 8 | Jira | The Atlassian app's callback URL; registered webhooks | Change the callback URL. There are **no webhooks registered today**. Once there are, a rename leaves them pointing at the old host: the daily refresh compares only the filter, not the address. Re-register after switching. | yes (once webhooks exist) | Settings, Integrations, Jira. |
| 9 | Web widget and the Vircle app | Every `<script src="https://crm.vircle.tech/widget/loader.js">` on a website or in a WebView | Update embeds to the new address (the snippet in Settings updates itself). **Keep the old host serving `/widget/*` and `/api/widget/*`** until every embed is changed. The app's WebView needs a release to change. | **yes** | Old-host access log: hits on `/widget/loader.js`. |
| 10 | Vircle Chat gateway | The workspace's stored webhook address | `node dist/cli.js update-workspace --key vcw_... --halo-url https://halo.vircle.tech/api/vircle-chat/webhook`. Events retry for 72 hours, so a gap is recoverable. | **yes** | `node dist/cli.js outbox` shows nothing pending or given up. |
| 11 | Server scheduled jobs | The host crontab: every line names the host | Edit every line to the new host. Add the four jobs that are missing (section 8, step 0). | **yes** | Platform, Background jobs: every job "On time". |
| 12 | The MCP server and the public API | `WACRM_BASE_URL` in each user's MCP config | None today (0 API keys). Update when someone uses it. | no | n/a |
| 13 | Links people hold | Invitation and notification emails already sent, bookmarks, saved passwords, browser autofill, a pasted link in team chat | Old pages keep working while the old host exists; redirect browser pages to the new host after a month. Saved passwords are per host: people re-save. | no | n/a |
| 14 | Monitoring and documentation | Uptime checks, runbooks, wiki pages, the chat gateway's deploy notes | Update them. | no | n/a |

## 6. Recommended plan

**Phase 0, preparation (no one notices, about 2 hours).** Take the baseline (section 3). Add the four missing jobs to the
crontab (section 8, step 0) and wait a day to see all nine report. Find out who has access to the Meta app, the Entra app
registration, the Atlassian app and the Supabase dashboard. Read `/opt/wacrm/.env.local` for the two settings in row 3.
Ask who embeds the chat widget (row 9). Pick a quiet time for phase 2.

**Phase 1, add the new address (no one notices, about 1 hour).** DNS and nginx (rows 1 and 2) so both names serve the whole
app. In Supabase, add the new redirect pattern. In Meta, Microsoft and Atlassian, **add** the new redirect URIs and App Domain
(additive: nothing breaks). Test sign-in on the new address.

**Phase 2, switch (the only visible step, 30 to 60 minutes).** Set the two settings (row 3) and redeploy. Switch the Meta
webhook callbacks (rows 5 and 6). Update the gateway (row 10). Edit the crontab (row 11). Recreate the mail subscription
(row 7). Switch the Supabase Site URL (row 4). Sign in on the new address, then send one message through each channel.

**Phase 3, transition (30 days, mostly waiting).** The old host keeps answering every machine call. Turn its browser pages into
a permanent redirect to the new host, but not `/api/*` or `/widget/*`. Watch its access log (section 7): any webhook or
widget hit that remains names something still registered at the old address.

**Phase 4, retire.** When the old host has been silent for two weeks, remove it from the proxy, or keep it as a permanent
alias. Re-save passwords, update bookmarks, close the change.

**Rollback** at any point before phase 4 is a configuration flip (the two settings, the Meta callbacks, the gateway
address), about 10 minutes, because the old address never stopped working.

## 7. Measuring the impact

| What | Where | Baseline today | Healthy after the switch |
| --- | --- | --- | --- |
| Inbound messages per channel per day | the `messages` table, by `channel_type` (section 3) | see section 3 | Same pattern within a day of the switch; WhatsApp and Messenger within minutes. |
| Webhook calls per address | nginx access log, if it records the host (add `$host` to the log format first) | not recorded | New host rising, old host falling to zero. A call still arriving on the old host names a registration you missed. |
| Widget loads per address | same log, `/widget/loader.js` | not recorded | Falls as embeds are updated; zero before you retire the old host. |
| Sign-in failures | Supabase, Authentication, Logs | 0 expected | A short rise on switch day (six people), then flat. |
| Scheduled jobs | Platform, Background jobs | 4 of 9 reporting | 9 of 9 "On time". |
| Mail subscription | `email_config.subscription_expires_at` | 5 Oct 2026 | Moves forward by 3 days at each renewal. |
| Chat gateway to Halo | `node dist/cli.js outbox` on the server | not yet measured | 0 waiting, 0 given up. |
| People | A short note to the six users | none | Nobody locked out; no "link does not work" reports. |

Suggested nginx log line (records the host and how long each request took):

```
log_format with_host '$remote_addr [$time_local] $host "$request" $status $body_bytes_sent $request_time';
access_log /var/log/nginx/halo-access.log with_host;
```

Count machine calls per host once a day:

```
awk '$5 ~ /\/api\/.*webhook|\/widget\// {print $3}' /var/log/nginx/halo-access.log | sort | uniq -c
```

## 8. Commands for the steps that are easy to get wrong

**Step 0, the missing scheduled jobs.** First see what the crontab has: `ssh root@187.127.105.156 "crontab -l"`. The four
lines to add are (use the same secret the existing lines use):

```
* * * * *   curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://crm.vircle.tech/api/incidents/escalation-cron
*/2 * * * * curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://crm.vircle.tech/api/integrations/jira/cron
*/5 * * * * curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://crm.vircle.tech/api/messages/sweep-cron
15 3 * * *  curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://crm.vircle.tech/api/email/subscription-renew
```

(After the rename, the same lines with `halo.vircle.tech`. `docs/automations-and-cron.md` lists all nine.)

**Row 7, recreate the Microsoft 365 mail subscription after the switch.** In the Supabase SQL editor:

```
update email_config set subscription_id = null, subscription_expires_at = null where status = 'connected';
```

Then run the renewal job once by hand, or wait for the nightly run. It creates a fresh subscription pointing at the new
address. Until the old one expires, both hosts must answer `/api/email/webhook`. Halo ignores a message it already has, so the
overlap is harmless.

**Row 10, the gateway.**

```
cd /opt/wacrm && docker compose -f docker-compose.gateway.yml --env-file .env.gateway exec gateway \
  node dist/cli.js update-workspace --key vcw_NBShjT2XdT7Dt-73quKW5mrt --halo-url https://halo.vircle.tech/api/vircle-chat/webhook
```

## 9. Decisions for you

1. **Keep the old address for how long?** I recommend 30 days as a full alias, then a redirect for browser pages and either a
   permanent alias or removal for machine traffic.
2. **Who holds the Meta, Microsoft, Atlassian and Supabase logins**, and when are they available together?
3. **Where is the chat widget embedded?** Websites, and the Vircle app? Only you can tell: the database has no list.
4. **Is Google or Microsoft single sign-on used to sign in to Halo?** If so, only Supabase's allowed-redirect list is involved.
5. **A quiet time** for phase 2. The last 24 hours had only 3 Messenger and 2 Vircle Chat messages, so most hours are quiet; avoid the hours when the six people are working in Halo.

## 10. Two small code changes I would make first (not done; about half a day)

* **Detect a changed address and recreate**, for the Jira webhooks and the Microsoft 365 subscription, so a future rename
  heals itself instead of needing the manual steps in rows 7 and 8.
* **A "URLs to register" panel in Settings** listing every callback and webhook address Halo expects at the current host,
  ready to copy into Meta, Microsoft and Atlassian. It turns section 5 into a copy-and-paste list and doubles as a check
  after the switch.
