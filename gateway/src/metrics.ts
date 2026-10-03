// ============================================================
// GET /metrics, in the Prometheus text format (any scraper reads it; so does `curl`). Behind METRICS_TOKEN: unset
// means the endpoint does not exist. Almost everything is read from the database at scrape time, so the numbers are
// exact and survive restarts; the rest is the process itself.
//
// The ones worth an alert:
//   vircle_gateway_outbox_oldest_seconds       Halo is not accepting events (check Halo, then `cli outbox`)
//   vircle_gateway_outbox_failed               events given up on, waiting for a person
//   vircle_gateway_undelivered_oldest_seconds  messages from support the user's app has not taken
//   vircle_gateway_push_failed_1h              the push API is failing
//   vircle_gateway_db_pool_waiting             the database pool is exhausted
//   vircle_gateway_event_loop_lag_p99_seconds  the process is overloaded
// ============================================================

import { monitorEventLoopDelay } from 'node:perf_hooks'

import type { Db } from './db'
import type { Hub } from './hub'
import type { Store } from './store'

const loop = monitorEventLoopDelay({ resolution: 20 })
loop.enable()

const started = Date.now()

export async function renderMetrics(s: { store: Store; hub: Hub; db: Db | null }): Promise<string> {
  const lines: string[] = []
  const gauge = (name: string, help: string, value: number, type: 'gauge' | 'counter' = 'gauge') => {
    lines.push(`# HELP vircle_gateway_${name} ${help}`, `# TYPE vircle_gateway_${name} ${type}`, `vircle_gateway_${name} ${Number.isFinite(value) ? value : 0}`)
  }
  const m = await s.store.metricsSnapshot()
  gauge('connections', 'Open app connections.', s.hub.size)
  gauge('connections_accepted_total', 'App connections accepted since start.', s.hub.totalAdded, 'counter')
  gauge('outbox_pending', 'Events waiting to be sent to Halo.', m.outboxPending)
  gauge('outbox_retrying', 'Of those, events that failed at least once.', m.outboxRetrying)
  gauge('outbox_oldest_seconds', 'Age of the oldest event waiting for Halo.', m.outboxOldestSeconds)
  gauge('outbox_failed', 'Events given up on (see cli outbox, retry-failed).', m.outboxFailed)
  gauge('undelivered', 'Messages from support the user has not received.', m.undelivered)
  gauge('undelivered_oldest_seconds', 'Age of the oldest of those.', m.undeliveredOldestSeconds)
  gauge('messages_in_1h', 'Messages from users in the last hour.', m.inLastHour)
  gauge('messages_out_1h', 'Messages from support in the last hour.', m.outLastHour)
  gauge('push_sent_1h', 'Alerts sent in the last hour.', m.pushSentLastHour)
  gauge('push_failed_1h', 'Alerts that failed in the last hour.', m.pushFailedLastHour)
  gauge('push_no_device_1h', 'Alerts with no device to send to in the last hour.', m.pushNoDeviceLastHour)
  gauge('users', 'Users known to the gateway.', m.users)
  gauge('messages_stored', 'Messages currently stored.', m.messages)
  gauge('files_stored', 'Files currently stored.', m.files)
  gauge('file_bytes_stored', 'Bytes of files currently stored.', m.fileBytes)
  const pool = s.db?.stats?.()
  if (pool) {
    gauge('db_pool_connections', 'Database connections open.', pool.total)
    gauge('db_pool_idle', 'Of those, idle.', pool.idle)
    gauge('db_pool_waiting', 'Queries waiting for a free connection.', pool.waiting)
    gauge('db_pool_max', 'The pool limit (DB_POOL_MAX).', pool.max)
  }
  const mem = process.memoryUsage()
  gauge('process_rss_bytes', 'Resident memory.', mem.rss)
  gauge('process_heap_used_bytes', 'Heap in use.', mem.heapUsed)
  const cpu = process.cpuUsage()
  gauge('process_cpu_seconds_total', 'CPU time used since start (rate() of it is the cores in use; one Node process tops out at 1).', (cpu.user + cpu.system) / 1e6, 'counter')
  gauge('process_uptime_seconds', 'Seconds since start.', (Date.now() - started) / 1000)
  gauge('event_loop_lag_p99_seconds', 'p99 delay of the event loop since the last scrape.', loop.percentile(99) / 1e9)
  gauge('event_loop_lag_max_seconds', 'Worst delay of the event loop since the last scrape.', loop.max / 1e9)
  loop.reset()
  return lines.join('\n') + '\n'
}
