// postgres.js connection pool singleton.
//
// Admin pool: direct connection, no role-setting, bypasses RLS. Used wherever
// the codebase previously used the Supabase service-role client.
//
// User pool: same physical pool; individual queries wrap themselves in a short
// transaction that does SET LOCAL role='authenticated' + jwt.claims so
// PostgreSQL's RLS policies see auth.uid() and auth.role() exactly as they
// did through PostgREST.
//
// Env vars:
//   DATABASE_URL       postgres://user:pass@host:5432/db  (required)
//   DATABASE_SSL       set to 'false' to disable TLS (e.g. local dev)

import postgres from 'postgres'

let _pool: ReturnType<typeof postgres> | null = null

export function getPool(): ReturnType<typeof postgres> {
  if (!_pool) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is not set — cannot use postgres.js client')
    _pool = postgres(url, {
      max: 10,
      idle_timeout: 30,
      connect_timeout: 10,
      ssl: process.env.DATABASE_SSL === 'false' ? false : 'prefer',
    })
  }
  return _pool
}
