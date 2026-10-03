# Vircle Chat gateway: runbook

For whoever looks after `chat.vircle.tech`. Plain steps, no theory. The gateway is one container (`gateway`) and its own
Postgres (`gateway-db`) on the Halo VPS (`root@187.127.105.156`, `/opt/wacrm`), started from
`docker-compose.gateway.yml`. Halo itself is separate and is not touched by anything here.

Every command is run on the server, in `/opt/wacrm`. Shorthand used below:

```bash
cd /opt/wacrm
alias gw='docker compose -f docker-compose.gateway.yml --env-file .env.gateway'
```

## 1. Is it healthy? (two minutes, once a day while in pilot)

| Check | Command | Healthy |
| --- | --- | --- |
| Up, and can reach its database | `curl -s https://chat.vircle.tech/readyz` | `{"ok":true,"connections":N}` |
| Containers | `gw ps` | both `running`, gateway `healthy` |
| Queues | `curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:8090/metrics \| grep -E 'outbox\|undelivered\|push_failed\|pool_waiting'` | see section 2 |
| Errors in the last hour | `gw logs --since 1h gateway \| grep '"level":"error"'` | nothing |
| Last backup | `ls -lh /opt/backups/gateway \| tail -3` | one from last night |
| Disk | `df -h /` and `docker system df` | under 80% |

Point an uptime monitor (UptimeRobot, Better Stack, anything) at `https://chat.vircle.tech/readyz`. It is the one URL that is
false when the gateway or its database is down.

## 2. The numbers that matter (`/metrics`)

`/metrics` needs `METRICS_TOKEN` in `.env.gateway` (otherwise it does not exist) and is blocked by nginx from outside the
server: read it on the server, or from a scraper running there. Prometheus text format.

| Metric | Normal | If it is not |
| --- | --- | --- |
| `outbox_oldest_seconds` | 0 to a few seconds | Halo is not accepting events. Section 3, **Halo is down or slow** |
| `outbox_failed` | 0 | Events Halo refused for good, or gave up on after 72 h. Section 3, **Events given up on** |
| `undelivered_oldest_seconds` | small | Support messages the user's app has not taken. Normal for users who are away; a growing oldest with `push_failed_1h` above 0 means alerts are failing |
| `push_failed_1h` | 0 | The push API is failing. Section 3, **Alerts are not reaching phones** |
| `db_pool_waiting` | 0 most of the time | Short spikes in a burst are fine. Constantly above 0: raise `DB_POOL_MAX` (section 6) |
| `event_loop_lag_p99_seconds` | under 0.1 | The process is overloaded: look at `process_cpu_seconds_total`, section 6 |
| `process_cpu_seconds_total` | rate well under 1 | A rate near 1 is one full core, the most one gateway can use |
| `process_rss_bytes` | about 100 MB idle, 250 to 300 MB under heavy load, flat over time | Steady growth over days: restart (section 4) and tell the developer |
| `connections` | the people with the app open | |

## 3. When something is wrong

**Halo is down or slow.** The app keeps working: messages from users are stored on the gateway and wait in the outbox, in order,
retried with growing waits (2 s up to 15 min), for 72 hours. When Halo is back they all arrive, once each. Nothing to do except fix
Halo. Check: `gw logs --since 30m gateway | grep dispatcher`. If events are slow rather than failing, raise `DISPATCH_CONCURRENCY` (section 6).

**Events given up on** (`outbox_failed` above 0). Either Halo answered 400/413/422 (it read the event and refused it: the reason is
stored) or Halo stayed unreachable for 72 hours. See them, fix the cause, queue them again:

```bash
gw exec gateway node dist/cli.js outbox
gw exec gateway node dist/cli.js retry-failed
```

**Alerts are not reaching phones.** The gateway decides: socket when the app is open, otherwise one push alert (via the Vircle push
API). While `PUSH_ADAPTER=mock` alerts are only recorded, never sent: expected until work package 8. After that,
`push_failed_1h` above 0 means the push API is refusing or unreachable: `gw logs --since 1h gateway | grep push`. Messages are not lost:
the user sees them when they open the chat.

**The gateway restarts in a loop.** `gw logs --tail 50 gateway`. The line says why: `DATABASE_URL is required` or
`GATEWAY_ENCRYPTION_KEY is required` (the `.env.gateway` file is wrong or missing), `connect ECONNREFUSED` (the database is not up: `gw ps`).

**Everything stored by the gateway looks wrong or was lost.** Restore the last backup (section 5). Halo keeps the conversations, so
what is lost is only the gateway's own copy of the last day.

**A user says their chat is empty.** The gateway keeps delivered messages 30 days (`RETENTION_DAYS`); the full history is in Halo. If
the app is a new install, the history it shows is what the gateway still holds.

**Too many connections / someone is hammering it.** nginx limits one address to 300 connections and 30 requests a second (burst
100) and answers 429. Look: `tail -f /var/log/nginx/access.log | grep chat.vircle.tech`. Block an address:
`ufw deny from 203.0.113.9`.

## 4. Updating and restarting

```bash
cd /opt/wacrm && git pull origin main && gw up --build -d
```

Takes about 30 seconds. The gateway tells every connected phone to reconnect (close code 1012) and exits; the phones resume where
they were and the new process takes them within seconds (measured: 1,000 phones back in about 2 seconds, nothing lost). Database
changes (migrations) are applied by the gateway itself when it starts. Do it at a quiet hour anyway.

Restart without updating: `gw restart gateway`. Never `docker compose down -v`: `-v` deletes the database volume.

## 5. Backups and restore

**Nightly backup** (do this once):

```bash
chmod +x deploy/gateway-backup.sh deploy/gateway-restore.sh
deploy/gateway-backup.sh                          # try it now: should print "backup ok"
( crontab -l 2>/dev/null; echo '15 2 * * * /opt/wacrm/deploy/gateway-backup.sh >> /var/log/gateway-backup.log 2>&1' ) | crontab -
```

It keeps 14 days in `/opt/backups/gateway`, refuses to keep a dump that is incomplete, and exits non-zero on any problem. A
backup on the same machine is lost with the machine: copy the folder off the server (`OFFSITE_RSYNC=user@host:/path/` in the cron
line, or a cloud sync). **Keep `GATEWAY_ENCRYPTION_KEY` outside this server too**: without it a restored database cannot sign events for Halo
(you would re-register the workspace with `update-workspace`, which also works, but it is better not to need it).

**Prove a backup works, monthly** (touches nothing live):

```bash
deploy/gateway-restore.sh --verify "$(ls -t /opt/backups/gateway/gateway-*.sql.gz | head -1)"
```

It loads the dump into a scratch database, prints what is inside (users, messages, files, migrations) and drops it.

**Restore for real** (database lost or damaged):

```bash
deploy/gateway-restore.sh --restore /opt/backups/gateway/gateway-2026-10-03-0215.sql.gz
```

It asks you to type `restore`, stops the gateway, keeps the old database under another name until the new one has loaded, starts the
gateway, and prints what it contains. If loading fails it puts the old database back.

## 6. Settings you may need (`.env.gateway`, then `gw up -d`)

| Setting | Default | When to change it |
| --- | --- | --- |
| `RETENTION_DAYS` | 30 | How long delivered messages, files and events stay. Lower it if the disk fills; undelivered ones stay three times as long. Purging runs every 6 hours, in small batches |
| `DISPATCH_CONCURRENCY` | 16 | Conversations sent to Halo at the same moment. Raise (24, 32) if `outbox_oldest_seconds` grows while Halo is healthy but slow. Each one is a request Halo must handle at the same time |
| `DB_POOL_MAX` | 20 | Raise to 40 if `db_pool_waiting` stays above 0. The gateway's Postgres allows 100 |
| `LOG_LEVEL` | info | `debug` for a short investigation, then back |
| `METRICS_TOKEN` | unset | Set it to turn `/metrics` on |
| `SIMULATOR_ENABLED` | true | **false** for a production launch |
| `PUSH_ADAPTER` | mock | `vircle` after work package 8 |

## 7. Limits to know

One gateway process on one server (the design: simple, and enough). Measured on a laptop with the load test
(`docs/vircle-chat-gateway-loadtest.md`): 2,500 connected phones, 150 messages a second each way, 30% of one CPU core and about 290 MB.
The first things to bend are Halo's own webhook speed and, much later, the one CPU core a Node process can use, not memory (about 25 KB per idle phone).
There is no second instance: two would both send events to Halo (harmless, Halo ignores repeats) but could reorder them. The way up
is a bigger server, then splitting by workspace, which is a design change for later.

Files are stored in the database (16 MB at most each). A user who sends many large videos grows it; `docker system df` and
`gw exec gateway-db psql -U gateway -c "SELECT pg_size_pretty(pg_database_size('gateway'))"` show how much. Retention removes files
once their messages are gone.

## 8. Security checklist for a production launch

- `SIMULATOR_ENABLED=false`.
- `METRICS_TOKEN` set, and `/metrics` reachable only from the server (nginx already blocks outside access).
- `.env.gateway` is `chmod 600`, owned by root, not in git.
- `GATEWAY_ENCRYPTION_KEY` and the sessions key are stored in a password manager. The sessions key (printed by `create-workspace`
  and by `rotate-sessions-key`) is only given to the Vircle backend developer. If it was ever pasted into chat or email, rotate it:
  `gw exec gateway node dist/cli.js rotate-sessions-key --key vcw_...`.
- Halo's API token and webhook secret rotate in Halo (Settings, Channels, Vircle Chat); then run `update-workspace` on the gateway
  with the new value.
- Firewall: only 80 and 443 (and SSH) reach the server; the gateway's port 8090 is bound to `127.0.0.1`.
- Logs never contain message text, tokens, phone numbers or secrets; keep it that way when adding log lines.

## 9. What was and was not tested

Tested here, automatically: the whole suite (about 300 tests) on both an in-process Postgres and a real Postgres 16
(`npm run test:pg`); the load test below on a real Postgres 16 with the production entry point; retention, metrics, readiness.
**Not tested from this side** (needs the server): the backup and restore scripts (syntax-checked only: run `--verify` once and
tell me what it printed), the nginx limits, the Docker settings (logging, `init`, `ulimits`), and real push delivery.
