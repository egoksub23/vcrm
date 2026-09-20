import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createSource, parseImportOptions, saveImportedDrafts } from './import-save'

const COLL = '0f8fad5b-d9cb-469f-a165-70867728950e'

describe('parseImportOptions', () => {
  it('defaults to English and no collection', () => {
    expect(parseImportOptions(undefined, undefined)).toEqual({ ok: true, language: 'en', collectionId: null })
    expect(parseImportOptions('', '')).toEqual({ ok: true, language: 'en', collectionId: null })
    expect(parseImportOptions(null, null)).toEqual({ ok: true, language: 'en', collectionId: null })
  })
  it('accepts a language and a collection', () => {
    expect(parseImportOptions('zh', COLL)).toEqual({ ok: true, language: 'zh', collectionId: COLL })
  })
  it('rejects unknown values', () => {
    expect(parseImportOptions('fr', null)).toEqual({ ok: false, error: 'language must be en, ms or zh' })
    expect(parseImportOptions('en', 'nope')).toEqual({ ok: false, error: 'collection_id must be a collection id' })
    expect(parseImportOptions(5, null).ok).toBe(false)
  })
})

function insertDb(result: { data?: unknown; error?: { code?: string } | null }) {
  const state: { table: string; rows: Record<string, unknown>[] } = { table: '', rows: [] }
  const db = {
    from: (table: string) => ({
      insert: (rows: Record<string, unknown> | Record<string, unknown>[]) => {
        state.table = table
        state.rows = Array.isArray(rows) ? rows : [rows]
        const done = Promise.resolve({ data: result.data ?? null, error: result.error ?? null })
        return { select: () => Object.assign(done, { single: () => done }) }
      },
    }),
  }
  return { db: db as unknown as SupabaseClient, state }
}

const CTX = { accountId: 'acct', userId: 'user' }
const ITEM = { title: 'T', content: 'C', content_html: '<p>C</p>', kind: 'article' as const }

describe('saveImportedDrafts', () => {
  it('always saves drafts, owned by the importer, with the chosen language and collection', async () => {
    const { db, state } = insertDb({ data: [{ id: 'd1', title: 'T' }] })
    const r = await saveImportedDrafts(db, CTX, [ITEM, { ...ITEM, kind: 'qa', content_html: null }], {
      language: 'ms',
      collectionId: COLL,
      sourceId: 'src1',
    })
    expect(r).toEqual({ ok: true, documents: [{ id: 'd1', title: 'T' }] })
    expect(state.table).toBe('ai_knowledge_documents')
    expect(state.rows).toHaveLength(2)
    for (const row of state.rows) {
      expect(row).toMatchObject({
        status: 'draft',
        created_by: 'user',
        updated_by: 'user',
        account_id: 'acct',
        language: 'ms',
        collection_id: COLL,
        source_id: 'src1',
      })
    }
    expect(state.rows[1]).toMatchObject({ kind: 'qa', content_html: null })
  })

  it('maps a missing collection and a permission failure to friendly errors', async () => {
    const opts = { language: 'en' as const, collectionId: COLL }
    expect(await saveImportedDrafts(insertDb({ error: { code: '23503' } }).db, CTX, [ITEM], opts)).toMatchObject({ ok: false, status: 400 })
    expect(await saveImportedDrafts(insertDb({ error: { code: '42501' } }).db, CTX, [ITEM], opts)).toMatchObject({ ok: false, status: 403 })
    expect(await saveImportedDrafts(insertDb({ error: { code: 'XX' } }).db, CTX, [ITEM], opts)).toMatchObject({ ok: false, status: 500 })
  })
})

describe('createSource', () => {
  it('records where an import came from', async () => {
    const { db, state } = insertDb({ data: { id: 'src1' } })
    expect(await createSource(db, CTX, { kind: 'url', name: 'Hours', url: 'https://a.com', checksum: 'abc' })).toBe('src1')
    expect(state.table).toBe('knowledge_sources')
    expect(state.rows[0]).toMatchObject({ kind: 'url', url: 'https://a.com', checksum: 'abc', sync_status: 'ok', account_id: 'acct' })
  })
  it('returns null rather than failing the import when the record cannot be saved', async () => {
    const { db } = insertDb({ error: { code: 'XX' } })
    expect(await createSource(db, CTX, { kind: 'file', name: 'a.pdf', checksum: null })).toBeNull()
  })
})
