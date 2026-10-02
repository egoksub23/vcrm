import fs from 'node:fs'
import path from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { decrypt, encrypt, keyIdOf } from '@/lib/whatsapp/encryption'
import { ENCRYPTED_COLUMNS, encryptionReport, reencryptAll } from './reencrypt'

const ORIGINAL = process.env.ENCRYPTION_KEY!
const K1 = '1'.repeat(64)
const saved = { ...process.env }

function setEnv(env: Record<string, string | undefined>) {
  for (const k of ['ENCRYPTION_KEY', 'ENCRYPTION_KEYS', 'ENCRYPTION_KEY_ID']) delete process.env[k]
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v
}

type Row = Record<string, unknown>

/** Just enough of the query builder: select/order/limit/gt for reads, update/eq/select for the swap. */
function fakeDb(tables: Record<string, Row[]>, hooks: { beforeUpdate?: (table: string) => void } = {}) {
  const db = {
    from(table: string) {
      const rows = tables[table]
      const filters: [string, unknown][] = []
      let gt: [string, string] | null = null
      let limit = Infinity
      let patch: Row | null = null
      const run = () => {
        if (!rows) return { data: null, error: { code: '42P01', message: 'missing' } }
        if (patch) {
          hooks.beforeUpdate?.(table)
          const hit = rows.filter((r) => filters.every(([k, v]) => r[k] === v))
          hit.forEach((r) => Object.assign(r, patch))
          return { data: hit.map((r) => ({ ...r })), error: null }
        }
        let out = rows.map((r) => ({ ...r }))
        if (gt) out = out.filter((r) => String(r[gt![0]]) > gt![1])
        out.sort((a, b) => String(a.id ?? a.connection_id).localeCompare(String(b.id ?? b.connection_id)))
        return { data: out.slice(0, limit), error: null }
      }
      const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => builder,
        limit: (n: number) => ((limit = n), builder),
        gt: (k: string, v: string) => ((gt = [k, v]), builder),
        update: (p: Row) => ((patch = p), builder),
        eq: (k: string, v: unknown) => (filters.push([k, v]), builder),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
      }
      return builder
    },
  }
  return db as unknown as SupabaseClient
}

beforeEach(() => setEnv({ ENCRYPTION_KEY: ORIGINAL }))
afterEach(() =>
  setEnv({ ENCRYPTION_KEY: saved.ENCRYPTION_KEY, ENCRYPTION_KEYS: saved.ENCRYPTION_KEYS, ENCRYPTION_KEY_ID: saved.ENCRYPTION_KEY_ID }),
)

function rotate() {
  setEnv({ ENCRYPTION_KEY: ORIGINAL, ENCRYPTION_KEYS: `2026a:${K1}`, ENCRYPTION_KEY_ID: '2026a' })
}

describe('reencryptAll', () => {
  it('rewrites every stale value under the new key and leaves plaintext alone', async () => {
    const tables = {
      whatsapp_config: [
        { id: 'w1', access_token: encrypt('wa-token'), verify_token: 'plain-verify', app_secret_enc: null },
      ],
      jira_connection_secrets: [
        { connection_id: 'j1', access_token_enc: encrypt('jira-a'), refresh_token_enc: encrypt('jira-r') },
      ],
    }
    rotate()
    const result = await reencryptAll(fakeDb(tables))
    expect(result).toEqual({ rewritten: 3, unreadable: 0, conflicts: 0, finished: true })

    const w = tables.whatsapp_config[0]
    expect(keyIdOf(w.access_token as string)).toBe('2026a')
    expect(decrypt(w.access_token as string)).toBe('wa-token')
    expect(w.verify_token).toBe('plain-verify')
    expect(w.app_secret_enc).toBeNull()
    expect(decrypt(tables.jira_connection_secrets[0].refresh_token_enc as string)).toBe('jira-r')
  })

  it('is idempotent: a second run has nothing to do', async () => {
    const tables = { ai_connections: [{ id: 'a1', api_key: encrypt('sk-1') }] }
    rotate()
    const db = fakeDb(tables)
    expect((await reencryptAll(db)).rewritten).toBe(1)
    expect(await reencryptAll(db)).toEqual({ rewritten: 0, unreadable: 0, conflicts: 0, finished: true })
  })

  it('does nothing while no rotation has started (original format is still current)', async () => {
    const tables = { ai_connections: [{ id: 'a1', api_key: encrypt('sk-1') }] }
    const before = tables.ai_connections[0].api_key
    expect((await reencryptAll(fakeDb(tables))).rewritten).toBe(0)
    expect(tables.ai_connections[0].api_key).toBe(before)
  })

  it('counts a value it cannot decrypt and leaves it untouched', async () => {
    setEnv({ ENCRYPTION_KEY: '2'.repeat(64) }) // written under some other key
    const foreign = encrypt('x')
    setEnv({ ENCRYPTION_KEY: ORIGINAL, ENCRYPTION_KEYS: `2026a:${K1}`, ENCRYPTION_KEY_ID: '2026a' })
    const tables = { ai_connections: [{ id: 'a1', api_key: foreign }] }
    expect(await reencryptAll(fakeDb(tables))).toMatchObject({ rewritten: 0, unreadable: 1 })
    expect(tables.ai_connections[0].api_key).toBe(foreign)
  })

  it('never overwrites a value that changed while it ran', async () => {
    const tables = { gmail_config: [{ id: 'g1', access_token: encrypt('old'), refresh_token: null }] }
    rotate()
    const fresh = encrypt('refreshed-meanwhile')
    const db = fakeDb(tables, {
      beforeUpdate: () => {
        tables.gmail_config[0].access_token = fresh // a token refresh lands between our read and write
      },
    })
    expect(await reencryptAll(db)).toMatchObject({ rewritten: 0, conflicts: 1 })
    expect(tables.gmail_config[0].access_token).toBe(fresh)
  })

  it('pages through more rows than one page holds', async () => {
    const rows = Array.from({ length: 450 }, (_, i) => ({ id: `r${String(i).padStart(4, '0')}`, api_key: encrypt(`k${i}`) }))
    rotate()
    const result = await reencryptAll(fakeDb({ ai_connections: rows }))
    expect(result.rewritten).toBe(450)
    expect(rows.every((r) => keyIdOf(r.api_key as string) === '2026a')).toBe(true)
  })

  it('stops at the time budget and reports it is not finished', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, api_key: encrypt(`k${i}`) }))
    rotate()
    expect(await reencryptAll(fakeDb({ ai_connections: rows }), { budgetMs: -1 })).toMatchObject({ rewritten: 0, finished: false })
  })

  it('skips a table that does not exist yet', async () => {
    rotate()
    expect(await reencryptAll(fakeDb({}))).toEqual({ rewritten: 0, unreadable: 0, conflicts: 0, finished: true })
  })
})

describe('encryptionReport', () => {
  it('counts values by the key they were written with and the stale total', async () => {
    const legacy = encrypt('a')
    rotate()
    const current = encrypt('b')
    const report = await encryptionReport(
      fakeDb({ whatsapp_config: [{ id: 'w1', access_token: legacy, verify_token: 'plain', app_secret_enc: current }] }),
    )
    expect(report.currentKeyId).toBe('2026a')
    expect(report.versioned).toBe(true)
    expect(report.loadedKeyIds.sort()).toEqual(['2026a', 'legacy'])
    expect(report.stale).toBe(1)
    const by = Object.fromEntries(report.columns.filter((c) => c.table === 'whatsapp_config').map((c) => [c.column, c]))
    expect(by.access_token.byKey).toEqual({ legacy: 1 })
    expect(by.app_secret_enc.byKey).toEqual({ '2026a': 1 })
    expect(by.verify_token.unrecognised).toBe(1)
    expect(JSON.stringify(report)).not.toContain(K1)
  })
})

describe('ENCRYPTED_COLUMNS covers what the app writes', () => {
  // Names that hold encrypt() output on its way to a listed column (the p_* ones are RPC parameters
  // saved into jira_connection_secrets), the re-encrypt job's own variable, or a short-lived row.
  const NOT_COLUMNS = new Set([
    'encryptedAccessToken', 'encryptedVerifyToken', 'encryptedKey', 'enc', 'blob', 'next', 'p_access_enc', 'p_refresh_enc',
  ])

  function* sourceFiles(dir: string): Generator<string> {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) yield* sourceFiles(full)
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) yield full
    }
  }

  it('every column assigned from encrypt() is in the list', () => {
    const known = new Set(ENCRYPTED_COLUMNS.flatMap((t) => t.columns))
    const missing = new Set<string>()
    const re = /(\w+)\s*(?::|=)\s*(?:[^;\n]*\?\s*)?encrypt\(/g
    for (const file of sourceFiles(path.join(process.cwd(), 'src'))) {
      if (file.endsWith(path.join('whatsapp', 'encryption.ts'))) continue
      const text = fs.readFileSync(file, 'utf8')
      for (const m of text.matchAll(re)) {
        if (!NOT_COLUMNS.has(m[1]) && !known.has(m[1])) missing.add(`${m[1]} (${path.relative(process.cwd(), file)})`)
      }
    }
    expect([...missing]).toEqual([])
  })
})
