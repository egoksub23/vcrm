import type { SupabaseClient } from '@supabase/supabase-js'

import { decrypt, encrypt, keyIdOf, needsReencrypt } from '@/lib/whatsapp/encryption'
import { getKeyRing } from '@/lib/crypto/keyring'

// ============================================================
// Where encrypted secrets live, and the operator's re-encrypt job.
//
// After a key rotation starts (ENCRYPTION_KEY_ID names a new key) every secret
// written from then on uses it, but everything stored earlier stays under the
// old key until it is rewritten. `reencryptAll` rewrites them, so the old key
// can be retired. It is idempotent and safe to interrupt: each value is
// replaced only if it is still the value we read (compare and swap), so a
// token refreshed at the same moment is never overwritten with stale data.
//
// Keep ENCRYPTED_COLUMNS in step with every column the app writes with
// encrypt(). A test pins the list against the call sites' tables.
// ============================================================

export interface EncryptedTable {
  table: string
  pk: string
  columns: readonly string[]
}

export const ENCRYPTED_COLUMNS: readonly EncryptedTable[] = [
  { table: 'ai_configs', pk: 'id', columns: ['api_key', 'embeddings_api_key'] },
  { table: 'ai_connections', pk: 'id', columns: ['api_key'] },
  { table: 'email_config', pk: 'id', columns: ['access_token', 'refresh_token', 'client_state'] },
  { table: 'gmail_config', pk: 'id', columns: ['access_token', 'refresh_token'] },
  { table: 'instagram_config', pk: 'id', columns: ['page_access_token', 'long_lived_user_token', 'verify_token'] },
  { table: 'messenger_config', pk: 'id', columns: ['page_access_token', 'long_lived_user_token', 'verify_token'] },
  { table: 'tiktok_config', pk: 'id', columns: ['access_token', 'refresh_token'] },
  { table: 'webhook_endpoints', pk: 'id', columns: ['secret'] },
  { table: 'whatsapp_config', pk: 'id', columns: ['access_token', 'verify_token', 'app_secret_enc'] },
  { table: 'jira_connection_secrets', pk: 'connection_id', columns: ['access_token_enc', 'refresh_token_enc'] },
  { table: 'web_widget_config', pk: 'id', columns: ['identity_secret_enc'] },
  { table: 'vircle_chat_config', pk: 'id', columns: ['signing_secret', 'api_token'] },
]

const PAGE = 200
const MISSING_TABLE = new Set(['42P01', 'PGRST205'])

type Row = Record<string, unknown>

/** Visit every row of one table, a keyset page at a time. Returns false when the table does not exist. */
async function scanTable(
  db: SupabaseClient,
  spec: EncryptedTable,
  visit: (row: Row) => Promise<void> | void,
  stopAt?: number,
): Promise<{ exists: boolean; finished: boolean }> {
  let last: string | null = null
  for (;;) {
    if (stopAt !== undefined && Date.now() > stopAt) return { exists: true, finished: false }
    let q = db
      .from(spec.table)
      .select([spec.pk, ...spec.columns].join(', '))
      .order(spec.pk, { ascending: true })
      .limit(PAGE)
    if (last !== null) q = q.gt(spec.pk, last)
    const { data, error } = await q
    if (error) {
      if (error.code && MISSING_TABLE.has(error.code)) return { exists: false, finished: true }
      throw new Error(`${spec.table}: ${error.message}`)
    }
    const rows = (data ?? []) as unknown as Row[]
    for (const row of rows) await visit(row)
    if (rows.length < PAGE) return { exists: true, finished: true }
    last = String(rows[rows.length - 1][spec.pk])
  }
}

export interface ColumnReport {
  table: string
  column: string
  /** Stored values, by the key they were written with (`legacy`, `legacy-cbc` or a ring id). */
  byKey: Record<string, number>
  /** Values that are not in an encrypted shape (empty, or a plaintext verify token). */
  unrecognised: number
}

export interface EncryptionReport {
  /** Key new secrets are written under. */
  currentKeyId: string
  /** False while ENCRYPTION_KEY_ID is unset: the original format is still being written. */
  versioned: boolean
  /** Every key id loaded into the ring (ids only, never key material). */
  loadedKeyIds: string[]
  columns: ColumnReport[]
  /** Values the job would rewrite now. */
  stale: number
}

export async function encryptionReport(db: SupabaseClient): Promise<EncryptionReport> {
  const ring = getKeyRing()
  const columns: ColumnReport[] = []
  let stale = 0
  for (const spec of ENCRYPTED_COLUMNS) {
    const reports = new Map<string, ColumnReport>(
      spec.columns.map((c) => [c, { table: spec.table, column: c, byKey: {}, unrecognised: 0 }]),
    )
    const { exists } = await scanTable(db, spec, (row) => {
      for (const column of spec.columns) {
        const value = row[column]
        if (typeof value !== 'string' || value === '') continue
        const report = reports.get(column)!
        const id = keyIdOf(value)
        if (id === null) report.unrecognised += 1
        else report.byKey[id] = (report.byKey[id] ?? 0) + 1
        if (needsReencrypt(value)) stale += 1
      }
    })
    if (exists) columns.push(...reports.values())
  }
  return {
    currentKeyId: ring.current.id,
    versioned: ring.current.versioned,
    loadedKeyIds: [...ring.keys.keys()],
    columns,
    stale,
  }
}

export interface ReencryptResult {
  rewritten: number
  /** Stale values that could not be decrypted with any loaded key. Left untouched. */
  unreadable: number
  /** Values that changed while we worked (a token refresh). Picked up on the next run. */
  conflicts: number
  /** False when the time budget ran out first: run it again. */
  finished: boolean
}

export async function reencryptAll(
  db: SupabaseClient,
  { budgetMs = 40_000 }: { budgetMs?: number } = {},
): Promise<ReencryptResult> {
  const stopAt = Date.now() + budgetMs
  const result: ReencryptResult = { rewritten: 0, unreadable: 0, conflicts: 0, finished: true }

  for (const spec of ENCRYPTED_COLUMNS) {
    const { finished } = await scanTable(
      db,
      spec,
      async (row) => {
        for (const column of spec.columns) {
          const value = row[column]
          if (typeof value !== 'string' || !needsReencrypt(value)) continue

          let next: string
          try {
            next = encrypt(decrypt(value))
          } catch {
            result.unreadable += 1
            continue
          }

          const { data, error } = await db
            .from(spec.table)
            .update({ [column]: next })
            .eq(spec.pk, row[spec.pk] as string)
            .eq(column, value)
            .select(spec.pk)
          if (error) throw new Error(`${spec.table}.${column}: ${error.message}`)
          if ((data ?? []).length === 0) result.conflicts += 1
          else result.rewritten += 1
        }
      },
      stopAt,
    )
    if (!finished) {
      result.finished = false
      break
    }
  }
  return result
}
