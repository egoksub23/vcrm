# Scheduled jobs (cron)

Nothing inside the Halo container is scheduled. Several features only work
if something outside it calls a URL on a timer. This page lists every job,
how often to call it, and how to tell that it is actually running.

## How a job is called

Every job is a `GET` with the shared secret in a header:

```bash
curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/automations/cron
```

- `AUTOMATION_CRON_SECRET` must be set on the server (see `.env.local.example`).
  Without it every job answers **503**. A missing or wrong header answers **401**.
- The secret is compared in constant time (`src/lib/cron/guard.ts`, the one
  place that does the check for all jobs).
- Any scheduler works: the server's crontab, Vercel Cron, GitHub Actions, an
  uptime pinger. On the VPS it is the host crontab.

## The jobs

| Endpoint | What it does | Call it | Without it |
|---|---|---|---|
| `/api/automations/cron` | Runs the delayed ("Wait") steps of automations that have come due. | every 5 min | Wait steps never resume. |
| `/api/flows/cron` | Times out flow runs a customer abandoned (default 24 h). | hourly | Abandoned runs block new flow triggers for that customer forever. |
| `/api/sla/cron` | Notifies when a conversation has waited longer than its workspace's response-time target. | every 5 min | No "response time exceeded" alerts. |
| `/api/sla/tickets-cron` | Marks ticket SLA breaches and sends at-risk and breached notices. | every minute | Ticket SLA state is shown live but never stored or notified. |
| `/api/incidents/escalation-cron` | Escalates unacknowledged incidents up the levels. | every minute | Incidents never auto-escalate. |
| `/api/integrations/jira/cron` | Jira job queue, catch-up poll, webhook renewal. | every 1 to 2 min | Jira links stop syncing. |
| `/api/messages/sweep-cron` | Marks a send stuck in "sending" as failed after 10 min so it can be resent. | every 5 min | A crashed send stays "sending" forever. |
| `/api/email/subscription-renew` | Renews each Microsoft 365 mailbox's change-notification subscription. | daily | Inbound mail stops after about 3 days. |
| `/api/gmail/watch-renew` | Renews each Gmail push registration. | daily | Inbound Gmail stops after about 7 days. |

Example crontab (replace `YOUR-APP`):

```cron
* * * * *   curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/sla/tickets-cron
* * * * *   curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/incidents/escalation-cron
*/2 * * * * curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/integrations/jira/cron
*/5 * * * * curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/automations/cron
*/5 * * * * curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/sla/cron
*/5 * * * * curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/messages/sweep-cron
0 * * * *   curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/flows/cron
15 3 * * *  curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/email/subscription-renew
20 3 * * *  curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/gmail/watch-renew
```

`crontab` does not read your shell profile: write the secret into the line or
set `AUTOMATION_CRON_SECRET=...` at the top of the crontab file.

## Checking that they run

Each job records a heartbeat every time it is called. Sign in as a platform
operator and open **Platform**: the **Background jobs** card lists all nine
with the time of the last run.

- **On time**: ran within three expected intervals.
- **Late**: has not reported for three intervals. The usual cause is a missing
  or broken crontab line.
- **Failed**: the last run returned an error. The server log has the reason
  (`[cron <job>] failed:`).
- **Not running**: it has never reported on this deployment.

## Behaviour with many workspaces

These guarantees apply to a deployment with several customers (migration 135):

- **Fair.** Jobs that pick work from a queue (delayed automation steps,
  conversation and ticket SLA, incident escalation, Jira) take a few items from
  each workspace in turn, so one workspace with a large backlog cannot keep the
  others waiting.
- **Suspended workspaces are skipped.** A workspace the operator has suspended
  gets no automation steps, no SLA notices, no escalations, no Jira work, no
  mailbox renewals and no AI replies. Resuming it picks the work up again.
- **Safe to overlap and to crash.** A delayed automation step is claimed with a
  10-minute lease. If the server dies mid-step, the step is marked **failed**
  after the lease (not run a second time: its earlier actions may already have
  reached the customer) and the automation log records why.
- **Bounded.** Each run stops starting new work after about 45 seconds and
  hands unstarted work back, so a slow run cannot overlap the next one for long.
  The flow sweep reads a page at a time and reports `truncated: true` if it ran
  out of time; the next run continues.

## Adding a job

Wrap the route with `cronRoute(name, expectedSeconds, handler)` from
`src/lib/cron/guard.ts` and add the name and interval to `CRON_INTERVALS`
there. That gives it the secret check, the heartbeat, a generic 500 on failure,
and a row in the console. Add a translation for its label under `Platform.job_<name>`.
