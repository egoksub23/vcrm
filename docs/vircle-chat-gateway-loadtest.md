# Vircle Chat gateway: load test

3 Oct 2026, work package 7. Script: `gateway/scripts/loadtest.ts` (`npm run loadtest` in `gateway/`). Repeatable: run it again after any
change, and on the real server size before launch.

## What was tested, and how

- **The real thing, not a mock.** The gateway runs as a separate process through its production entry point (`dist/server.js`), on a
  real **PostgreSQL 16** (the same version the server runs), reached through the real `pg` driver. The load generator is another process:
  one pretend phone per user, each a real WebSocket speaking the real protocol; a pretend Halo that accepts every event after a
  fixed delay (100 ms, a plausible webhook time; `--halo-latency` changes it).
- **Seven phases:** connect, sit idle, every user sends at the same instant, Halo writes to every user at the same instant, a steady
  rate both ways, a third of the users go away (push path) and come back, and the gateway is killed and restarted with every phone
  reconnecting at once.
- **Where:** a laptop (12 cores, 16 threads, 32 GB), with the gateway, Postgres and the load generator all on it, so the numbers include
  the load generator's own work and are pessimistic for the gateway. The server will not be the same: repeat on it.
- **Not covered:** real network latency and mobile networks, real Halo, real push, many days of running (a 150-second soak showed memory
  flat), files (covered by the functional tests, not by load).

## Results

All users connected, every message arrived exactly once, every user who went away got their message when they came back, and every
phone was back after a restart, at both sizes. Nothing failed.

| | 1,000 users | 2,500 users |
| --- | --- | --- |
| Connect all (session request + socket + hello) | 2.6 s, per user p95 0.44 s | 4.2 s, per user p95 0.25 s |
| Idle: CPU of one core / memory | 2% / 102 MB | 2% / 139 MB |
| **Everyone sends in the same instant**: send to acknowledgement, p50 / p99 | 0.8 s / 1.0 s | 1.6 s / 2.0 s |
| ...until Halo has received every event (100 ms per call, 16 at a time) | 7.8 s | 19.8 s |
| **Halo writes to everyone in the same instant**: until the phone has it, p50 / p99 | 0.8 s / 1.4 s | 1.7 s / 3.2 s |
| **Steady 100 (1,000 users) or 150 (2,500 users) messages a second each way**: send to ack, p50 / p99 | 36 ms / 70 ms | 39 ms / 106 ms |
| ...Halo write accepted, p50 / p99 | 80 ms / 115 ms | 94 ms / 185 ms |
| ...CPU of one core / memory | 30% / 249 MB | 26% / 290 MB |
| A third go away, Halo writes to them: push alerts recorded | 330 of 330 | 825 of 825 |
| ...they reconnect and replay, p50 / p99 | 0.2 s / 0.24 s | 0.2 s / 0.24 s |
| **Gateway killed and restarted, every phone reconnects at once**: all online again, p50 / p99 | 1.3 s / 1.9 s | 2.1 s / 4.2 s |
| Event loop delay, p99 | under 60 ms throughout | under 60 ms throughout |

(The first reading in a phase run after a restart shows CPU 0 because the counter restarts with the process.)

## What it showed, and what was changed because of it

1. **Events to Halo were sent one at a time.** The first run, with a 100 ms Halo, delivered about 66 events a second at best; with real
   Halo latencies one at a time would have been 5 to 10 a second, and a burst or a slow Halo would have put users minutes behind.
   **Changed:** events are now sent in parallel, one lane per conversation (`DISPATCH_CONCURRENCY`, default 16). Order is still kept
   inside a conversation (a reply never reaches Halo before the message it answers); different people no longer wait for each other. If
   Halo keeps refusing, a pass stops after three failures instead of trying every conversation against a Halo that is down.
   Result: the burst of 1,000 drained in 7.8 s instead of 15 s, now limited by Halo's own 100 ms per call, and a steady 100 a second
   no longer builds a backlog.
2. **Tests on PGlite hid driver differences.** The whole test suite was run on the real Postgres: four tests failed because they
   assumed a database that answers instantly (not because the gateway was wrong). Fixed; the suite now runs on both
   (`npm run test:pg`).
3. **A real latency bug that only a real Postgres shows.** The database stamps a new event to the microsecond; the gateway compared that
   with a millisecond clock and, when the check came in the same millisecond, called the event "not due yet". On a quiet system the
   first message after a pause then waited for the next two-second poll before reaching Halo. Two tests failed on real Postgres and
   pointed at it. **Changed:** "due" is now decided by the database's own clock, with a regression test.
4. **Sessions were never purged**, and retention (documented in the scope) was not implemented. Both are now: delivered messages,
   files, events, push log and used sessions are purged on a schedule (`src/retention.ts`).
5. **Nothing to look at when it misbehaves.** Added: JSON logs, `/metrics`, `/readyz`, container log rotation, nginx flood limits.

## Where it bends (and what to do)

| Sign | Meaning | Do |
| --- | --- | --- |
| `outbox_oldest_seconds` grows while Halo is healthy | Halo is slower than `DISPATCH_CONCURRENCY` calls at a time can drain | Raise `DISPATCH_CONCURRENCY` (24, 32), check Halo's webhook time |
| `db_pool_waiting` stays above 0 | More simultaneous work than 20 database connections | `DB_POOL_MAX=40` |
| CPU of one core above about 70% for minutes | One Node process is nearly out | A faster CPU first; the gateway is single-instance by design |
| A same-instant burst takes about a second per 1,000 users to acknowledge | Expected: a burst queues for the database | Not a problem for real traffic, which spreads out |

Expected real load for a support channel is far below the steady rates tested; the burst rows are the worst case (every user acting in
the same second).
