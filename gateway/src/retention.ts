// ============================================================
// Retention: the gateway is a relay, not an archive (Halo keeps the conversation), so what it holds is bounded.
//
//   messages   delivered or read: RETENTION_DAYS after the last change (default 30)
//              still undelivered: 3 times that, so a user who comes back after a long break still finds them
//   files      once no message points at them, after a day (the day covers an upload not yet attached to a message)
//   events     sent to Halo: RETENTION_DAYS; given up on: 3 times that, kept for inspection
//   push log   RETENTION_DAYS
//   sessions   used or expired connect tokens, an hour after they expired
//
// Rows go in batches so one run never holds a long lock or writes a huge transaction. Users and conversations
// are never purged (they are small, and the conversation's sequence must never restart).
// ============================================================

import type { Db } from './db'

/** The longer keep for what was not delivered or was given up on, as a multiple of RETENTION_DAYS. */
export const UNDELIVERED_FACTOR = 3
const BATCH = 2000
const DAY_MS = 86_400_000
/** An uploaded file nothing points at is dropped after this. */
const ORPHAN_FILE_MS = DAY_MS

export interface RetentionResult {
  messages: number
  files: number
  events: number
  pushLog: number
  sessions: number
}

async function inBatches(db: Db, sql: string, params: unknown[]): Promise<number> {
  let total = 0
  for (;;) {
    const r = await db.query(sql, params)
    total += r.rowCount
    if (r.rowCount < BATCH) return total
  }
}

export async function runRetention(db: Db, opts: { days: number; now?: number }): Promise<RetentionResult> {
  const now = opts.now ?? Date.now()
  const keep = new Date(now - opts.days * DAY_MS).toISOString()
  const keepLong = new Date(now - opts.days * UNDELIVERED_FACTOR * DAY_MS).toISOString()
  const orphanBefore = new Date(now - ORPHAN_FILE_MS).toISOString()

  const messages = await inBatches(
    db,
    `DELETE FROM messages WHERE id IN (
       SELECT id FROM messages
        WHERE (status IN ('delivered', 'read', 'failed') AND COALESCE(read_at, delivered_at, created_at) < $1)
           OR created_at < $2
        LIMIT ${BATCH})`,
    [keep, keepLong],
  )
  // After the messages: a file whose message was just purged is unreferenced now.
  const files = await inBatches(
    db,
    `DELETE FROM files WHERE id IN (
       SELECT f.id FROM files f
        WHERE f.status = 'ready' AND f.created_at < $1
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = f.conversation_id AND m.media->>'file_id' = f.id)
        LIMIT ${BATCH})`,
    [orphanBefore],
  )
  const events = await inBatches(
    db,
    `DELETE FROM outbox_events WHERE id IN (
       SELECT id FROM outbox_events
        WHERE (dispatched_at IS NOT NULL AND dispatched_at < $1) OR (failed_at IS NOT NULL AND failed_at < $2)
        LIMIT ${BATCH})`,
    [keep, keepLong],
  )
  const pushLog = await inBatches(
    db,
    `DELETE FROM push_log WHERE id IN (SELECT id FROM push_log WHERE created_at < $1 LIMIT ${BATCH})`,
    [keep],
  )
  const sessions = await inBatches(
    db,
    `DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE expires_at < $1 LIMIT ${BATCH})`,
    [new Date(now - 3_600_000).toISOString()],
  )
  return { messages, files, events, pushLog, sessions }
}
