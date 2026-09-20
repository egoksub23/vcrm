import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ getCurrentAccount: vi.fn() }))
vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: h.getCurrentAccount,
  requireAnyCapability: vi.fn(),
  toErrorResponse: () => Response.json({ error: 'auth failed' }, { status: 403 }),
}))

import { GET } from './route'
import type { KnowledgeLibraryResponse } from '@/lib/knowledge-types'

type Row = Record<string, unknown>

/** A stand-in for the few queries the library GET makes. */
function fakeSupabase(tables: Record<string, Row[]>, rpcs: Record<string, unknown>) {
  const from = (table: string) => {
    const rows = tables[table] ?? []
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'order', 'range', 'is']) chain[m] = () => chain
    chain.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null })
    chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null, count: rows.length })
    return chain
  }
  return { from, rpc: (name: string) => Promise.resolve({ data: rpcs[name] ?? null, error: null }) }
}

const doc = (over: Row) => ({
  id: 'd',
  title: 'T',
  kind: 'article',
  language: 'en',
  status: 'published',
  use_in_ai: true,
  category: null,
  collection_id: null,
  review_by: null,
  updated_at: '2026-09-20T12:00:00Z',
  created_by: 'u1',
  source_conversation_id: null,
  source_id: null,
  translation_of: null,
  machine_translated: false,
  translated_from_at: null,
  ...over,
})

beforeEach(() => h.getCurrentAccount.mockReset())

describe('GET /api/knowledge with translations', () => {
  it('lists each base with its translations, credits it with their AI uses and counts articles once', async () => {
    const supabase = fakeSupabase(
      {
        ai_knowledge_documents: [
          doc({ id: 'base', collection_id: 'c1' }),
          doc({ id: 'ms1', language: 'ms', translation_of: 'base', collection_id: 'c1', machine_translated: true, status: 'draft', translated_from_at: '2026-09-20T10:00:00Z' }),
          doc({ id: 'zh1', language: 'zh', translation_of: 'base', collection_id: 'c1', translated_from_at: '2026-09-20T12:00:00Z' }),
          doc({ id: 'other', collection_id: 'c1' }),
        ],
        knowledge_collections: [{ id: 'c1', name: 'Billing', color: '#7C3AED', sort_order: 0 }],
        knowledge_attachments: [{ document_id: 'base' }, { document_id: 'ms1' }],
      },
      {
        kb_usage_counts: [
          { document_id: 'base', uses: 2 },
          { document_id: 'zh1', uses: 5 },
          { document_id: 'other', uses: 1 },
        ],
        kb_ai_answers: 9,
      },
    )
    h.getCurrentAccount.mockResolvedValue({ supabase, accountId: 'acct' })

    const body = (await (await GET()).json()) as KnowledgeLibraryResponse
    const byId = new Map(body.documents.map((d) => [d.id, d]))

    // every row is still there (the page decides what to show), translations linked
    expect(body.documents).toHaveLength(4)
    expect(byId.get('ms1')).toMatchObject({ translation_of: 'base', machine_translated: true, translations: [] })
    expect(byId.get('base')?.translations).toEqual([
      { language: 'ms', id: 'ms1', status: 'draft', out_of_date: true, machine_translated: true },
      { language: 'zh', id: 'zh1', status: 'published', out_of_date: false, machine_translated: false },
    ])
    // the base is credited with its translations' uses; a translation row shows its own
    expect(byId.get('base')?.ai_uses).toBe(7)
    expect(byId.get('zh1')?.ai_uses).toBe(5)
    expect(byId.get('other')?.ai_uses).toBe(1)
    expect(byId.get('base')?.attachment_count).toBe(1)
    // the internal marker is not part of the contract
    expect(byId.get('ms1')).not.toHaveProperty('translated_from_at')
    // a translation is the same article: the collection counts two, not four
    expect(body.collections[0].article_count).toBe(2)
    expect(body.ai_answers_30d).toBe(9)
  })
})
