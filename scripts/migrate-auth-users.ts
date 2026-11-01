#!/usr/bin/env tsx
// ============================================================
// Migrate auth.users from Supabase → self-hosted PostgreSQL
//
// Supabase auth.users is not accessible via PostgREST — it lives
// in Supabase's internal auth schema. We fetch it via the Admin
// auth API (service role key required) and insert into the stub
// auth.users table created by bootstrap-pg.sql.
//
// Required env vars:
//   NEXT_PUBLIC_SUPABASE_URL   — Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY  — service-role key
//   DATABASE_URL               — target postgres://...
//   DATABASE_SSL               — set to "false" if local (optional)
// ============================================================

import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'

function required(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1) }
  return v
}

async function main() {
  const supabaseUrl = required('NEXT_PUBLIC_SUPABASE_URL')
  const serviceKey  = required('SUPABASE_SERVICE_ROLE_KEY')
  const dbUrl       = required('DATABASE_URL')

  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const pg = postgres(dbUrl, {
    max: 3,
    ssl: process.env.DATABASE_SSL === 'false' ? false : 'prefer',
    idle_timeout: 30,
    connect_timeout: 15,
  })

  await pg`SELECT 1`
  console.log('✓ Connected to target PostgreSQL')

  let page = 1
  let total = 0

  for (;;) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) { console.error(`Error fetching users page ${page}: ${error.message}`); process.exit(1) }
    if (!data?.users?.length) break

    for (const user of data.users) {
      await pg`
        INSERT INTO auth.users (id, email, phone, created_at, updated_at, deleted_at, is_anonymous)
        VALUES (
          ${user.id},
          ${user.email ?? null},
          ${user.phone ?? null},
          ${user.created_at ? new Date(user.created_at) : new Date()},
          ${user.updated_at ? new Date(user.updated_at) : new Date()},
          ${user.deleted_at ? new Date(user.deleted_at) : null},
          ${user.is_anonymous ?? false}
        )
        ON CONFLICT (id) DO UPDATE SET
          email      = EXCLUDED.email,
          phone      = EXCLUDED.phone,
          updated_at = EXCLUDED.updated_at
      `
    }

    total += data.users.length
    console.log(`  Page ${page}: ${data.users.length} users (${total} total)`)

    if (data.users.length < 1000) break
    page++
  }

  console.log(`✓ Migrated ${total} auth users`)
  await pg.end()
}

main().catch(err => { console.error(String(err)); process.exit(1) })
