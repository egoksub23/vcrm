# Ticket SLA and business hours

Vircle can hold every ticket to a **first-response** target and a **resolution**
target, counted in **business hours**. This page explains how the clock works,
what counts as a first response, how business time is measured, what to put in
cron, and the limits.

It covers tickets only. The account-wide **conversation** response time
(Settings > Response time, `/api/sla/cron`) is separate and unchanged.

## Where to set it up

Settings > **SLA & business hours** (needs the `sla.configure` permission:
Owner and Admin by default; an Agent can be given it in Roles & permissions, a
Viewer never can). Everyone in the workspace can see the SLA state on a ticket.

1. **Business hours** tab: a schedule is a time zone, the open time slots for
   each weekday (up to 4 a day, a slot never crosses midnight; use two slots for
   an overnight shift) and a list of holidays (whole closed days). One schedule is
   the default (pre-selected for new policies). A schedule that a policy uses
   cannot be deleted. **Load Mon-Fri 09:00-18:00** fills in a common week.
2. **SLA policies** tab: an ordered list. The **first active policy that matches
   a ticket wins**. Drag to reorder. A policy has conditions (priority, type,
   labels, channel of the linked conversation, team; an empty group means any),
   the two targets, the hours they are counted in (a schedule, or 24/7), whether
   the clock pauses while the ticket is pending, and the at-risk percentage
   (50 to 95, default 80). The dialog shows a live example computed with the same
   maths the database uses.

A ticket that matches no policy has no SLA and shows no badge. Nothing is created
for you: with no policies nobody has an SLA.

**Apply to open tickets** (on the policies tab) is a one-time button for tickets
that already exist: open, in-progress and pending tickets with no SLA get the
first matching policy, counted from their `created_at`, so an old ticket can start
out breached. It asks first and says how many tickets it will touch and how many
are already overdue. Editing or adding a policy later does **not** change tickets
that already have an SLA; a ticket is re-matched only when its priority, type,
labels, team or conversation change.

## How the clock works

The clock lives in the database (a trigger on `tickets`), so every way a ticket
can change (an agent, a board drag, a bulk edit, the Jira sync, the API) is
covered without the app having to remember.

| Ticket status | The clock |
| --- | --- |
| open, in progress | runs |
| pending (waiting on the customer) | **pauses** (unless the policy says to keep running). The business time still left is remembered and laid out again from the moment the ticket leaves pending. |
| resolved, closed | **stops**: a running target becomes **met** if it was on time, otherwise **breached** |
| reopened | a **met** resolution target restarts from the business time that was left when it stopped. A breached one stays breached. The first-response target never restarts. |

A target is breached strictly after its due time; a response at exactly the due
instant is on time. Each target has one of five states: none, running, paused,
met, breached. The badge on screen adds **at risk** (running and past the
policy's at-risk percentage of the target).

If a ticket's priority, type, labels, team or conversation change while it is
active, it is matched again. The new policy keeps the time already used:
`remaining = new target - elapsed business time`, laid out again from now in the
new schedule (from the pause moment while the ticket is pending). If nothing
matches any more, the running targets end (met and breached results are kept).
If a policy is deleted, running targets under it end; finished results stay.

Only the database writes the SLA columns. A browser (or an API client) that
tries to set them is ignored.

## What counts as a first response

The first **note written by a Vircle user on the ticket** (`ticket_comments`, not
synced from Jira and with an author). This is exactly the definition Reports >
Tickets already uses for its average first response (the earliest comment on the
ticket), narrowed to notes by a person, so the two numbers agree.

Two things follow from that, and both are worth knowing:

- Ticket notes are internal. A reply the agent sends to the customer in the
  linked chat is **not** a first response on the ticket. The ticket has no
  customer-visible reply of its own in this codebase.
- If a first response is recorded before a policy applies (the ticket had no SLA
  yet), the first-response target settles as met or breached as soon as a policy
  does apply.

A ticket that is resolved with no first response ever recorded settles its
first-response target by the clock: on time is met, late is breached.

## How business time is measured

The maths is written twice and kept identical: SQL (`sla_add_business_minutes`,
`sla_business_minutes_between`, and the exact-seconds versions the clock uses)
and TypeScript (`src/lib/sla/business-time.ts`, used for the countdown text and the
live preview). A shared set of fixtures is asserted by the unit tests and by
`supabase/ci/verify-086-ticket-sla.sql`, so they cannot drift apart.

- Slot boundaries are turned into real instants **one local date at a time** with
  the schedule's time zone. A day with a daylight-saving change therefore counts
  the real open time (a 00:00-04:00 slot is 3 hours on the New York spring-forward
  night and 5 hours on the fall-back night). Southern-hemisphere zones and zones
  without DST work the same way.
- A local time that does not exist (spring forward) or exists twice (fall back)
  resolves with the standard-time offset, the same as Postgres. Real schedules
  rarely have a slot edge at 02:00-03:00; if yours does, expect that behaviour.
- A slot is open from its start up to, but not including, its end. A target that
  ends exactly at closing time is due at closing time, not the next morning.
- A holiday closes its whole local day.
- Starting outside opening hours (evening, weekend, holiday): counting begins at
  the next opening. Zero minutes returns the start unchanged.
- A policy with no schedule counts wall-clock time (24/7).
- The walk covers **at most 366 local days**. A target that does not fit in that
  span (for example 555 business days) gives no due time: the target shows as
  none and the database raises a `WARNING`. It can never loop forever.

The countdown on a badge is in business time when the policy has a schedule, and
wall-clock time otherwise. It recomputes every 30 seconds in the browser from the
stored times; no request goes to the server.

## Notifications and the cron

`GET /api/sla/tickets-cron` runs one database call (`sla_sweep`, 200 tickets per
run). It marks running targets past their due time as breached and sends two
kinds of notification, each **once** per ticket and target:

- **`ticket_sla_at_risk`** when the policy's at-risk percentage of a target is used up;
- **`ticket_sla_breached`** when the target is missed (a breach also settles the
  at-risk notice, so nobody gets "at risk" after "breached").

Recipients: the assignee, or every Owner and Admin when the ticket is unassigned,
plus the ticket's watchers. Paused targets and finished tickets are left alone.
Two overlapping runs never take the same ticket (`FOR UPDATE SKIP LOCKED`), and a
backlog drains over the next runs. The state on screen does not wait for the
sweep (a running target past its due time already shows as breached); the sweep
stores it and sends the notices.

The endpoint uses the same secret as the other sweeps, `AUTOMATION_CRON_SECRET`,
sent as the `x-cron-secret` header. Add it to the crontab on the host, every
minute:

```
* * * * * curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" http://localhost:3000/api/sla/tickets-cron
```

(Use your app's URL. Without the secret the endpoint answers 503; with a wrong one, 401.)

The notification text is written in English by the database, like the other
ticket notifications. Clicking one opens the ticket.

## Reports

Reports > Tickets has an **SLA compliance** section for tickets created in the
selected range that have an SLA: first-response met % and resolution met %
(met / (met + breached); tickets still on the clock are not counted for or
against it), by priority and by team, and a list of the tickets that missed a
target, worst first, each linking to the ticket. It is one database aggregate
(`ticket_sla_report`), not a sum over rows in the browser.

## Limits

- 50 policies per workspace, 4 time slots per day, 200 holidays per schedule.
- Targets are whole minutes from 1 to 525600 (a year).
- Condition lists hold up to 50 entries; label conditions match a ticket that has
  **any** of the listed labels.
- A policy that names channels never matches a ticket with no linked conversation.
- Elapsed time across a policy change is measured in the business time of the
  policy being left. A target the old policy did not have starts from the
  ticket's creation, in the new schedule (pauses before that are not known).
- "Apply to open tickets" handles the oldest 5000 tickets per press; press it
  again for the rest.

## Where things live

| What | Where |
| --- | --- |
| Migration | `supabase/migrations/086_ticket_sla.sql` |
| Verify (rolled back) | `supabase/ci/verify-086-ticket-sla.sql` |
| Business-hours maths (TS) | `src/lib/sla/business-time.ts` |
| Clock rules (TS twin, for tests) | `src/lib/sla/state.ts` |
| Badge, countdown, filters, sort | `src/lib/sla/display.ts`, `src/components/tickets/ticket-sla-*.tsx` |
| Settings screens | `src/components/settings/sla/` |
| Routes | `src/app/api/account/sla/**`, `src/app/api/sla/tickets-cron/route.ts` |
