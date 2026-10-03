// ============================================================
// The gateway's database, behind a two-method interface so production can use
// `pg` (a real Postgres) and tests can use PGlite (an in-process Postgres, no
// Docker needed). Both speak the same SQL.
// ============================================================

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import pg from 'pg'

export interface QueryResult<T> {
  rows: T[]
  rowCount: number
}

/** Something SQL can be run on: the database itself, or one transaction of it. */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>
}

export interface Db extends Queryable {
  /** Run several statements as one all-or-nothing unit. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>
  /** Run a script of several statements (migrations). No parameters. */
  exec(sql: string): Promise<void>
  close(): Promise<void>
}

/** A real Postgres through a connection pool. */
export function createPgDb(connectionString: string, opts: { max?: number } = {}): Db {
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 10 })
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await pool.query(sql, params)
      return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 }
    },
    async tx<T>(fn: (q: Queryable) => Promise<T>) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const out = await fn({
          async query<R>(sql: string, params: unknown[] = []) {
            const r = await client.query(sql, params)
            return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 }
          },
        })
        await client.query('COMMIT')
        return out
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw err
      } finally {
        client.release()
      }
    },
    async exec(sql: string) {
      await pool.query(sql)
    },
    close: () => pool.end(),
  }
}

/**
 * Apply every `NNN_name.sql` in `dir` that has not been applied yet, in name order, each in its own
 * transaction. Safe to run on every start.
 */
export async function migrate(db: Db, dir: string): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name))
  const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort()
  const applied: string[] = []
  for (const file of files) {
    if (done.has(file)) continue
    const sql = await readFile(join(dir, file), 'utf8')
    await db.exec(`BEGIN;\n${sql}\nINSERT INTO schema_migrations (name) VALUES ('${file.replace(/'/g, "''")}');\nCOMMIT;`)
    applied.push(file)
  }
  return applied
}
