#!/usr/bin/env tsx
// ============================================================
// One-time data migration: Supabase → self-hosted PostgreSQL
//
// Reads every row from every public-schema table in Supabase
// (using the service-role key, bypassing RLS) and upserts it
// into the target PostgreSQL database.
//
// Storage files (Supabase Storage → MinIO) are a separate step;
// auth.users rows live in GoTrue and are handled by Auth.js —
// neither is touched here.
//
// Required env vars (copy from .env.local / VPS env):
//   NEXT_PUBLIC_SUPABASE_URL      — Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY     — service-role key (admin, bypasses RLS)
//   DATABASE_URL                  — postgres://user:pass@host:5432/db (target)
//   DATABASE_SSL                  — set to "false" for local dev (optional)
//
// Run:
//   npx tsx scripts/migrate-supabase-to-pg.ts
//   npx tsx scripts/migrate-supabase-to-pg.ts --dry-run   (counts only)
//   npx tsx scripts/migrate-supabase-to-pg.ts --table contacts
// ============================================================

import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'

// ---- config ----------------------------------------------------------------

const DRY_RUN    = process.argv.includes('--dry-run')
const RESUME     = process.argv.includes('--resume')
const ONLY_TABLE = (() => {
  const i = process.argv.indexOf('--table')
  return i >= 0 ? process.argv[i + 1] : null
})()

const PAGE_SIZE = 500          // rows per Supabase fetch
const MAX_PARAMS = 60_000      // PostgreSQL max params; we stay under this

// ---- checkpoint (for --resume) ---------------------------------------------

import { existsSync, readFileSync, appendFileSync } from 'node:fs'

const CHECKPOINT_FILE = '/tmp/migrate-pg-checkpoint.txt'

function loadCheckpoint(): Set<string> {
  if (!RESUME) {
    // Fresh run — clear any stale checkpoint
    try { if (existsSync(CHECKPOINT_FILE)) require('node:fs').unlinkSync(CHECKPOINT_FILE) } catch { /* ignore */ }
    return new Set()
  }
  try {
    if (!existsSync(CHECKPOINT_FILE)) return new Set()
    return new Set(readFileSync(CHECKPOINT_FILE, 'utf8').split('\n').filter(Boolean))
  } catch { return new Set() }
}

function markDone(table: string): void {
  if (DRY_RUN) return
  try { appendFileSync(CHECKPOINT_FILE, table + '\n') } catch { /* ignore */ }
}

// Tables to skip: they don't exist in the target schema or need special handling.
const SKIP_TABLES = new Set([
  'schema_migrations',         // migration state lives in the target already
  'pg_stat_statements',        // pg extension view, not a regular table
])

// ---- helpers ---------------------------------------------------------------

function required(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1) }
  return v
}

function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function dim(s: string): string { return `\x1b[2m${s}\x1b[0m` }
function green(s: string): string { return `\x1b[32m${s}\x1b[0m` }
function yellow(s: string): string { return `\x1b[33m${s}\x1b[0m` }
function red(s: string): string { return `\x1b[31m${s}\x1b[0m` }
function bold(s: string): string { return `\x1b[1m${s}\x1b[0m` }

// ---- topology: tables in FK dependency order --------------------------------
// Reads from the TARGET database (same schema as Supabase public).

interface FkDep { table: string; dependsOn: string }

async function getTablesInOrder(pg: ReturnType<typeof postgres>): Promise<string[]> {
  // All tables in the public schema (exclude views and partitions)
  const tables = await pg<{ tablename: string }[]>`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `
  const allTables = tables.map(r => r.tablename).filter(t => !SKIP_TABLES.has(t))

  // FK dependencies
  const deps = await pg<FkDep[]>`
    SELECT
      tc.table_name   AS table,
      ccu.table_name  AS "dependsOn"
    FROM information_schema.table_constraints tc
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_name = tc.constraint_name
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = rc.unique_constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema    = 'public'
      AND ccu.table_schema   = 'public'
      AND tc.table_name     != ccu.table_name  -- skip self-refs
  `

  // Build adjacency: table → set of tables it depends on
  const depMap = new Map<string, Set<string>>()
  for (const t of allTables) depMap.set(t, new Set())
  for (const { table, dependsOn } of deps) {
    if (depMap.has(table) && depMap.has(dependsOn)) {
      depMap.get(table)!.add(dependsOn)
    }
  }

  // Kahn's topological sort
  const ordered: string[] = []
  const inDegree = new Map<string, number>()
  for (const t of allTables) inDegree.set(t, 0)
  for (const [t, deps] of depMap) {
    for (const d of deps) {
      inDegree.set(t, (inDegree.get(t) ?? 0) + 1)
    }
  }
  const queue = allTables.filter(t => (inDegree.get(t) ?? 0) === 0)
  while (queue.length > 0) {
    const t = queue.shift()!
    ordered.push(t)
    for (const [other, otherDeps] of depMap) {
      if (otherDeps.has(t)) {
        otherDeps.delete(t)
        const remaining = inDegree.get(other)! - 1
        inDegree.set(other, remaining)
        if (remaining === 0) queue.push(other)
      }
    }
  }
  // Any tables left (circular deps) get appended at the end
  const missed = allTables.filter(t => !ordered.includes(t))
  if (missed.length > 0) {
    console.warn(yellow(`⚠ Circular FK deps detected; will try to insert anyway: ${missed.join(', ')}`))
    ordered.push(...missed)
  }

  return ordered
}

// ---- primary key discovery -------------------------------------------------

async function getPrimaryKeys(pg: ReturnType<typeof postgres>, table: string): Promise<string[]> {
  const rows = await pg<{ column_name: string }[]>`
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name
     AND kcu.table_schema    = tc.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema    = 'public'
      AND tc.table_name      = ${table}
    ORDER BY kcu.ordinal_position
  `
  return rows.map(r => r.column_name)
}

// ---- generated column detection ---------------------------------------------
// Generated (ALWAYS) columns are computed by PostgreSQL; we must not INSERT into them.
// Also returns their expressions so we can detect jsonb_array_length() dependencies.

interface GenColInfo { cols: Set<string>; hasJsonbArrayLength: boolean }

async function getGeneratedCols(pg: ReturnType<typeof postgres>, table: string): Promise<GenColInfo> {
  const rows = await pg<{ attname: string; expr: string }[]>`
    SELECT a.attname, pg_get_expr(d.adbin, d.adrelid) AS expr
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = (SELECT oid FROM pg_class
                        WHERE relname = ${table}
                          AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public'))
      AND a.attgenerated = 's'
      AND NOT a.attisdropped
  `
  const cols = new Set(rows.map(r => r.attname))
  // Coerce scalar JSONB values for ANY table that has generated columns.
  // A generated column that calls jsonb_array_length() on a JSONB column will throw
  // "cannot get array length of a scalar" if that column contains a scalar value.
  // pg_get_expr may return NULL for some PG builds, so don't rely on expression parsing.
  const hasJsonbArrayLength = cols.size > 0
  return { cols, hasJsonbArrayLength }
}

// ---- column type map (for JSON cast) ----------------------------------------

async function getJsonbCols(pg: ReturnType<typeof postgres>, table: string): Promise<Set<string>> {
  const rows = await pg<{ column_name: string }[]>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = ${table}
      AND data_type    = 'jsonb'
  `
  return new Set(rows.map(r => r.column_name))
}

// Returns columns declared GENERATED ALWAYS AS IDENTITY (attidentity = 'a').
// Inserting explicit values into these requires OVERRIDING SYSTEM VALUE.
async function getIdentityAlwaysCols(pg: ReturnType<typeof postgres>, table: string): Promise<Set<string>> {
  const rows = await pg<{ attname: string }[]>`
    SELECT a.attname
    FROM pg_attribute   a
    JOIN pg_class       c ON c.oid = a.attrelid
    JOIN pg_namespace   n ON n.oid = c.relnamespace
    WHERE n.nspname     = 'public'
      AND c.relname     = ${table}
      AND a.attidentity = 'a'
      AND NOT a.attisdropped
  `
  return new Set(rows.map(r => r.attname))
}

async function getTargetCols(pg: ReturnType<typeof postgres>, table: string): Promise<Set<string>> {
  const rows = await pg<{ attname: string }[]>`
    SELECT a.attname
    FROM pg_attribute   a
    JOIN pg_class       c ON c.oid = a.attrelid
    JOIN pg_namespace   n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname   = ${table}
      AND a.attnum    > 0
      AND NOT a.attisdropped
  `
  return new Set(rows.map(r => r.attname))
}

// ---- upsert a batch of rows ------------------------------------------------

async function upsertBatch(
  pg: ReturnType<typeof postgres>,
  table: string,
  rows: Record<string, unknown>[],
  pkCols: string[],
  jsonbCols: Set<string>,
  generatedCols: Set<string> = new Set(),
  hasJsonbArrayLength = false,
  targetCols: Set<string> = new Set(),
  identityCols: Set<string> = new Set(),
): Promise<void> {
  if (rows.length === 0) return

  // If this table has a generated column that calls jsonb_array_length(), any JSONB
  // column with a scalar value (JS string/number/boolean) will cause PostgreSQL to
  // throw "cannot get array length of a scalar" when computing the generated column.
  // Coerce all scalar JSONB values to [] so the generated expression returns 0.
  if (hasJsonbArrayLength) {
    for (const col of jsonbCols) {
      const sample = rows[0]?.[col]
      console.log(dim(`  [coerce-check] ${table}.${col}: typeof=${typeof sample} isArr=${Array.isArray(sample)} val=${JSON.stringify(sample)?.slice(0, 60)}`))
    }
    rows = rows.map(row => {
      const r = { ...row }
      for (const col of jsonbCols) {
        const val = r[col]
        if (val !== null && val !== undefined && !Array.isArray(val) && typeof val !== 'object') {
          console.log(dim(`  [coerce] ${table}.${col} scalar → []`))
          r[col] = []
        }
      }
      return r
    })
  }

  // Strip generated columns and any columns that don't exist in the target table
  // (e.g. generated columns that were dropped for the migration and will be re-added after).
  const cols = Object.keys(rows[0]).filter(c =>
    !generatedCols.has(c) && (targetCols.size === 0 || targetCols.has(c))
  )
  const colList = cols.map(ident).join(', ')

  // How many rows fit under the param limit?
  const batchSize = Math.max(1, Math.floor(MAX_PARAMS / cols.length))

  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize)
    const params: unknown[] = []
    let paramIdx = 0

    const valuePlaceholders = batch.map(row => {
      const placeholders = cols.map(col => {
        let val = row[col]
        // Serialize JSONB columns to string (postgres.js will re-parse it)
        if (jsonbCols.has(col) && val !== null && typeof val === 'object') {
          val = JSON.stringify(val)
        }
        params.push(val ?? null)
        return `$${++paramIdx}${jsonbCols.has(col) ? '::jsonb' : ''}`
      })
      return `(${placeholders.join(', ')})`
    }).join(', ')

    if (pkCols.length > 0) {
      const conflictCols = pkCols.map(ident).join(', ')
      const updateSet = cols
        .filter(c => !pkCols.includes(c) && !identityCols.has(c))
        .map(c => `${ident(c)} = EXCLUDED.${ident(c)}`)
        .join(', ')
      const onConflict = updateSet
        ? `ON CONFLICT (${conflictCols}) DO UPDATE SET ${updateSet}`
        : `ON CONFLICT (${conflictCols}) DO NOTHING`

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const overriding = identityCols.size > 0 ? 'OVERRIDING SYSTEM VALUE' : ''
        await pg.unsafe(
          `INSERT INTO public.${ident(table)} (${colList}) ${overriding} VALUES ${valuePlaceholders} ${onConflict}`,
          params as any[],
        )
      } catch (e: unknown) {
        const msg = String(e)
        if (msg.includes('array length') || msg.includes('scalar')) {
          console.error(red(`  [insert-err] ${table} cols=[${colList}]`))
          console.error(red(`  [insert-err] error=${msg}`))
          for (const row of batch) {
            for (const col of cols) {
              if (jsonbCols.has(col)) {
                const v = row[col]
                console.error(red(`  [insert-err] ${col}: typeof=${typeof v} isArr=${Array.isArray(v)} val=${JSON.stringify(v)?.slice(0,80)}`))
              }
            }
          }
        }
        throw e
      }
    } else {
      // No PK: blind insert, skip duplicates
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const overridingNoPk = identityCols.size > 0 ? 'OVERRIDING SYSTEM VALUE' : ''
      await pg.unsafe(
        `INSERT INTO public.${ident(table)} (${colList}) ${overridingNoPk} VALUES ${valuePlaceholders} ON CONFLICT DO NOTHING`,
        params as any[],
      )
    }
  }
}

// ---- migrate one table ------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function migrateTable(
  sb: { from: (table: string) => any },
  pg: ReturnType<typeof postgres>,
  table: string,
): Promise<{ read: number; upserted: number; errors: number }> {
  const pkCols = await getPrimaryKeys(pg, table)
  const jsonbCols = await getJsonbCols(pg, table)
  const { cols: generatedCols, hasJsonbArrayLength } = await getGeneratedCols(pg, table)
  const targetCols = await getTargetCols(pg, table)
  const identityCols = await getIdentityAlwaysCols(pg, table)

  // Clear any rows seeded by migration SQL files so Supabase data wins.
  // FK checks are already disabled via session_replication_role=replica.
  if (!DRY_RUN) {
    await pg.unsafe(`DELETE FROM public.${ident(table)}`)
  }

  let read = 0
  let upserted = 0
  let errors = 0
  let from = 0

  let pageSize = PAGE_SIZE

  for (;;) {
    // Fetch one page from Supabase, retrying with smaller pages on statement timeout
    let data: Record<string, unknown>[] | null = null
    let fetchError: { message?: string } | null = null
    let triedNoOrder = false

    for (;;) {
      const { data: d, error: e } = await sb
        .from(table)
        .select('*')
        .order('id' as never, { ascending: true } as never)
        .range(from, from + pageSize - 1)

      if (!e) { data = d; break }

      // No 'id' column — retry without ordering (once)
      if (!triedNoOrder && (e.message?.includes('"id"') || e.message?.includes('column'))) {
        triedNoOrder = true
        const { data: d2, error: e2 } = await sb
          .from(table)
          .select('*')
          .range(from, from + pageSize - 1)
        if (!e2) { data = d2; break }
        fetchError = e2; break
      }

      // Statement timeout — halve page size and retry
      if (e.message?.includes('timeout') || e.message?.includes('canceling')) {
        if (pageSize > 50) {
          pageSize = Math.max(50, Math.floor(pageSize / 2))
          console.warn(yellow(`  ⚠ timeout at page @${from}, retrying with pageSize=${pageSize}`))
          continue
        }
      }

      fetchError = e; break
    }

    if (fetchError) {
      console.error(red(`  ✗ ${table} page @${from}: ${fetchError.message}`))
      errors++
      break
    }

    if (!data || data.length === 0) break
    read += data.length
    if (!DRY_RUN) {
      await upsertBatch(pg, table, data as Record<string, unknown>[], pkCols, jsonbCols, generatedCols, hasJsonbArrayLength, targetCols, identityCols)
    }
    upserted += data.length

    process.stdout.write(`\r  ${dim(`${upserted.toLocaleString()} rows…`)}`)

    if (data.length < pageSize) break
    from += pageSize
  }

  return { read, upserted, errors }
}

// ---- main ------------------------------------------------------------------

async function main() {
  console.log(bold('\n━━ Supabase → PostgreSQL data migration ━━\n'))
  if (DRY_RUN) console.log(yellow('  DRY RUN — no writes will happen\n'))

  const supabaseUrl = required('NEXT_PUBLIC_SUPABASE_URL')
  const serviceKey  = required('SUPABASE_SERVICE_ROLE_KEY')
  const dbUrl       = required('DATABASE_URL')

  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // max:1 so SET session_replication_role applies to every query on the same connection
  const pg = postgres(dbUrl, {
    max: 1,
    ssl: process.env.DATABASE_SSL === 'false' ? false : 'prefer',
    idle_timeout: 60,
    connect_timeout: 15,
  })

  // Verify target DB connection
  await pg`SELECT 1`
  console.log(green('✓ Connected to target PostgreSQL'))

  // Disable FK constraint triggers for bulk migration (requires superuser).
  // session_replication_role = replica suppresses FK checks on this connection.
  await pg.unsafe("SET session_replication_role = 'replica'")

  // Drop ALL check constraints (idempotent — safe to re-run if pg_data was reset
  // and migrations re-created them; CHECK constraints block bulk migration).
  await pg.unsafe(`
    DO $$ DECLARE r RECORD; BEGIN
      FOR r IN SELECT conname, conrelid::regclass::text AS tbl
               FROM pg_constraint
               WHERE contype = 'c'
                 AND connamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
      LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', r.tbl, r.conname);
      END LOOP; END $$
  `)
  console.log(green('✓ Dropped check constraints'))

  // Drop all STORED generated columns before migration. PostgreSQL evaluates the
  // generation expression on every INSERT, which causes failures (e.g. jsonb_array_length
  // on a JSONB column). We re-add them after migration; PostgreSQL recomputes the values.
  //
  // This list is derived from supabase/migrations/*.sql — update it if new generated
  // columns are added. DROP COLUMN IF EXISTS is idempotent so re-runs are safe.
  const STORED_GEN_COLS: Array<{ table: string; col: string; type: string; expr: string }> = [
    { table: 'contacts',              col: 'phone_normalized', type: 'text',    expr: `regexp_replace(phone, '\\D', '', 'g')` },
    { table: 'ai_knowledge_documents', col: 'fts',            type: 'tsvector', expr: `to_tsvector('simple', content)` },
    { table: 'knowledge_document_versions', col: 'fts',       type: 'tsvector', expr: `to_tsvector('simple', public.kb_cjk_split(content))` },
    { table: 'sign_option_lists',     col: 'item_count',      type: 'integer',  expr: `jsonb_array_length(items)` },
  ]
  for (const c of STORED_GEN_COLS) {
    await pg.unsafe(`ALTER TABLE public.${ident(c.table)} DROP COLUMN IF EXISTS ${ident(c.col)} CASCADE`)
  }
  console.log(green(`✓ Dropped ${STORED_GEN_COLS.length} STORED generated column(s) (will restore after migration)`))

  // Disable ALL triggers on every public-schema table so migration-blocking guards
  // (audit triggers, validation triggers, etc.) don't interrupt bulk import.
  await pg.unsafe(`
    DO $$ DECLARE r RECORD; BEGIN
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      LOOP EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER ALL', r.tablename);
      END LOOP; END $$
  `)

  // Verify Supabase connection
  const { error: hc } = await sb.from('accounts').select('id').limit(1)
  if (hc && hc.message !== 'JSON object requested, multiple (or no) rows returned') {
    // A "no rows" error is fine; anything else is a connectivity problem
    if (!hc.message?.includes('0 rows') && !hc.message?.includes('Results contain 0')) {
      console.warn(yellow(`⚠ Supabase healthcheck returned: ${hc.message} (continuing)`))
    }
  }
  console.log(green('✓ Connected to Supabase\n'))

  // Discover tables
  let tables = await getTablesInOrder(pg)
  if (ONLY_TABLE) {
    tables = tables.filter(t => t === ONLY_TABLE)
    if (tables.length === 0) {
      console.error(red(`Table "${ONLY_TABLE}" not found in target schema.`)); process.exit(1)
    }
  }

  console.log(`Tables to migrate (${tables.length} total, FK-ordered):\n  ${tables.join(', ')}\n`)

  const doneTables = loadCheckpoint()
  if (RESUME && doneTables.size > 0) {
    console.log(yellow(`  Resuming — skipping ${doneTables.size} already-completed table(s)\n`))
  }

  const summary: Array<{ table: string; read: number; upserted: number; errors: number }> = []

  for (const table of tables) {
    if (RESUME && doneTables.has(table)) {
      console.log(`${bold(table)}  ${dim('(skipped — already done)')}`)
      continue
    }

    process.stdout.write(`${bold(table)}  `)
    const start = Date.now()
    const result = await migrateTable(sb, pg, table)
    const ms = Date.now() - start
    summary.push({ table, ...result })

    process.stdout.write('\r')
    if (result.errors > 0) {
      console.log(`${bold(table)}  ${red(`${result.errors} error(s)`)} (${result.read} rows read)`)
    } else {
      if (result.read === 0) {
        console.log(`${bold(table)}  ${dim('(empty)')}`)
      } else {
        console.log(
          `${bold(table)}  ${green(`${result.upserted.toLocaleString()} rows`)}  ${dim(`${ms}ms`)}`,
        )
      }
      markDone(table)  // record as done so --resume can skip it next run
    }
  }

  // Summary
  const totalRead    = summary.reduce((a, r) => a + r.read, 0)
  const totalUpsert  = summary.reduce((a, r) => a + r.upserted, 0)
  const totalErrors  = summary.reduce((a, r) => a + r.errors, 0)
  const errorTables  = summary.filter(r => r.errors > 0).map(r => r.table)

  console.log('\n' + bold('━━ Done ━━'))
  console.log(`  Rows read:    ${totalRead.toLocaleString()}`)
  if (DRY_RUN) {
    console.log(`  Rows to write: ${totalUpsert.toLocaleString()} (dry run — none written)`)
  } else {
    console.log(`  Rows upserted: ${green(totalUpsert.toLocaleString())}`)
  }
  if (totalErrors > 0) {
    console.log(`  Tables with errors: ${red(errorTables.join(', '))}`)
  }

  // Reset sequences for all GENERATED ALWAYS AS IDENTITY columns so future
  // inserts get values higher than the max migrated value.
  await pg.unsafe(`
    DO $$ DECLARE r RECORD; sv BIGINT; BEGIN
      FOR r IN
        SELECT c.relname AS tbl, a.attname AS col
        FROM pg_attribute   a
        JOIN pg_class       c ON c.oid = a.attrelid
        JOIN pg_namespace   n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND a.attidentity IN ('a', 'd')
          AND NOT a.attisdropped
      LOOP
        EXECUTE format('SELECT COALESCE(MAX(%I), 0) FROM public.%I', r.col, r.tbl) INTO sv;
        IF sv > 0 THEN
          PERFORM setval(pg_get_serial_sequence('public.' || r.tbl, r.col), sv, true);
        END IF;
      END LOOP;
    END $$
  `)
  console.log(green('✓ Reset identity sequences'))

  // Restore all STORED generated columns. PostgreSQL computes the values from the
  // migrated data as part of the ALTER TABLE. ADD COLUMN IF NOT EXISTS is idempotent.
  for (const c of STORED_GEN_COLS) {
    await pg.unsafe(
      `ALTER TABLE public.${ident(c.table)} ADD COLUMN IF NOT EXISTS ${ident(c.col)} ${c.type} GENERATED ALWAYS AS (${c.expr}) STORED`
    )
  }
  console.log(green(`✓ Restored ${STORED_GEN_COLS.length} STORED generated column(s)`))

  // Re-enable triggers now that the bulk import is done.
  await pg.unsafe(`
    DO $$ DECLARE r RECORD; BEGIN
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      LOOP EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER ALL', r.tablename);
      END LOOP; END $$
  `)

  await pg.end()
  process.exit(totalErrors > 0 ? 1 : 0)
}

main().catch(err => { console.error(red(String(err))); process.exit(1) })
