// PgDb — the postgres.js equivalent of the Supabase JS client.
//
// Exposes .from(table) and .rpc(fn, args) with the same { data, error } shape
// Supabase uses so call sites are unchanged.
//
// For user queries (userId provided) each operation runs inside a short
// BEGIN/SET LOCAL role='authenticated'/SET LOCAL "request.jwt.claims"=/COMMIT
// transaction so PostgreSQL's RLS policies see the right auth.uid().
// For admin queries (userId null) the operation runs on the pool user directly
// with no role switching, bypassing RLS exactly as the service-role key did.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Sql } from 'postgres'
import { getPool } from './client'
import { PgQueryBuilder } from './builder'

export class PgDb {
  readonly sql: Sql
  readonly schema: string
  readonly userId: string | null

  constructor(sql: Sql, schema = 'public', userId: string | null = null) {
    this.sql = sql
    this.schema = schema
    this.userId = userId
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from<T = any>(table: string): PgQueryBuilder<T> {
    return new PgQueryBuilder<T>(this.sql, this.schema, table, this.userId)
  }

  async rpc<T = unknown>(
    fn: string,
    args?: Record<string, unknown>,
    _opts?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean },
  ): Promise<{ data: T | null; error: { message: string; code?: string } | null; count?: number | null }> {
    try {
      const entries = Object.entries(args ?? {})
      let query: string
      let params: unknown[]

      if (entries.length === 0) {
        query = `SELECT * FROM "${fn.replace(/"/g, '""')}()`
        params = []
      } else {
        const namedParts = entries.map(([name], i) => `${name} := $${i + 1}`).join(', ')
        query = `SELECT * FROM "${fn.replace(/"/g, '""')}"(${namedParts})`
        params = entries.map(([, v]) => v)
      }

      let rows: Record<string, unknown>[]

      if (this.userId) {
        const claims = JSON.stringify({ sub: this.userId, role: 'authenticated' })
        rows = await this.sql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL role = 'authenticated'`)
          await tx.unsafe(`SET LOCAL "request.jwt.claims" = '${claims.replace(/'/g, "''")}'`)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return tx.unsafe<Record<string, unknown>[]>(query, params as any[])
        })
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rows = await this.sql.unsafe<Record<string, unknown>[]>(query, params as any[])
      }

      if (rows.length === 0) return { data: null, error: null }

      // Single row, single column named after the function → unwrap scalar
      if (rows.length === 1) {
        const keys = Object.keys(rows[0])
        if (keys.length === 1) {
          return { data: rows[0][keys[0]] as T, error: null }
        }
        return { data: rows[0] as unknown as T, error: null }
      }

      return { data: rows as unknown as T, error: null }
    } catch (err) {
      return {
        data: null,
        error: {
          message: err instanceof Error ? err.message : String(err),
          code: (err as { code?: string }).code,
        },
      }
    }
  }

  // Guard against accidental direct access; appStorage() wraps storage already.
  get storage(): never {
    throw new Error('[PgDb] .storage is not available — use appStorage() from @/lib/storage/provider')
  }

  get auth(): never {
    throw new Error('[PgDb] .auth is not available — use auth() from @/auth')
  }
}

export function createPgDb(userId: string | null): PgDb {
  return new PgDb(getPool(), 'public', userId)
}

export function createAdminPgDb(): PgDb {
  return new PgDb(getPool(), 'public', null)
}

// Cast helper so callers can do `createPgDb(id) as PgAsSupabase` without
// repeating the ugly cast everywhere.
export type PgAsSupabase = SupabaseClient
