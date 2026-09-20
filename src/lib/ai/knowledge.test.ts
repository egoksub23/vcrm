import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({ embedTexts: vi.fn() }))
vi.mock('./embeddings', () => ({
  embedTexts: h.embedTexts,
  toVectorLiteral: (v: number[]) => `[${v.join(',')}]`,
}))

import { searchKnowledge, retrieveKnowledge, ingestDocument, logKnowledgeUse, logKnowledgeGap } from './knowledge'

interface Row {
  chunk_id: string
  document_id: string
  title: string
  category: string | null
  language: 'en' | 'ms' | 'zh'
  content: string
}
const fts = (id: string, doc: string, content: string, rank = 0.5, language: Row['language'] = 'en') => ({
  chunk_id: id, document_id: doc, title: doc, category: null, language, content, rank,
})
const sem = (id: string, doc: string, content: string, distance: number, language: Row['language'] = 'en') => ({
  chunk_id: id, document_id: doc, title: doc, category: null, language, content, distance,
})

function makeDb(opts: { chunkCount?: number } = {}) {
  const state = {
    semantic: [] as ReturnType<typeof sem>[],
    fts: [] as ReturnType<typeof fts>[],
    chunkCount: opts.chunkCount ?? 5,
    rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
    inserted: null as Record<string, unknown>[] | null,
    insertedInto: null as string | null,
    deletedFor: null as string | null,
  }
  const db = {
    rpc: (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args })
      if (name === 'kb_match_semantic') return Promise.resolve({ data: state.semantic, error: null })
      if (name === 'kb_match_fts') return Promise.resolve({ data: state.fts, error: null })
      return Promise.resolve({ data: null, error: null })
    },
    from: (table: string) => ({
      select: () => ({ eq: () => Promise.resolve({ count: state.chunkCount, error: null }) }),
      delete: () => ({
        eq: (_c: string, val: string) => {
          state.deletedFor = val
          return Promise.resolve({ error: null })
        },
      }),
      insert: (rows: Record<string, unknown>[]) => {
        state.inserted = rows
        state.insertedInto = table
        return Promise.resolve({ error: null })
      },
    }),
  }
  return { db: db as unknown as SupabaseClient, state }
}

beforeEach(() => {
  h.embedTexts.mockReset()
})

describe('searchKnowledge — keyword path', () => {
  it('sends an OR query and the audience to the RPC', async () => {
    const { db, state } = makeDb()
    state.fts = [fts('c1', 'Refunds', 'Refunds\n\nFull refund within 30 days.')]
    const hits = await searchKnowledge(db, 'acct', { embeddingsApiKey: null }, 'refund after 30 days', { audience: 'ai' })
    expect(hits.map((x) => x.chunkId)).toEqual(['c1'])
    const call = state.rpcCalls.find((c) => c.name === 'kb_match_fts')!
    expect(call.args).toMatchObject({ p_account_id: 'acct', p_audience: 'ai', p_query: 'refund | after | 30 | days' })
    expect(state.rpcCalls.some((c) => c.name === 'kb_match_semantic')).toBe(false)
    expect(h.embedTexts).not.toHaveBeenCalled()
  })

  it('drops a keyword match that covers too little of a long question', async () => {
    const { db, state } = makeDb()
    state.fts = [fts('c1', 'Shipping', 'Shipping takes days.')]
    const hits = await searchKnowledge(
      db, 'acct', { embeddingsApiKey: null },
      'how many days until my invoice arrives for the pro plan yearly subscription', { audience: 'ai' },
    )
    expect(hits).toEqual([])
  })

  it('finds Chinese articles', async () => {
    const { db, state } = makeDb()
    state.fts = [fts('c1', '退款政策', '退款政策\n\n购买后三十天内可以全额退款。', 0.4, 'zh')]
    const hits = await searchKnowledge(db, 'acct', { embeddingsApiKey: null }, '退款政策', { audience: 'agent' })
    expect(hits).toHaveLength(1)
    expect(state.rpcCalls[0].args.p_query).toBe('(退 <-> 款) | (款 <-> 政) | (政 <-> 策)')
  })

  it('skips everything when the account has no published articles', async () => {
    const { db, state } = makeDb({ chunkCount: 0 })
    expect(await searchKnowledge(db, 'acct', { embeddingsApiKey: 'k' }, 'refund', { audience: 'ai' })).toEqual([])
    expect(h.embedTexts).not.toHaveBeenCalled()
    expect(state.rpcCalls).toHaveLength(0)
  })

  it('returns nothing for a blank query', async () => {
    const { db } = makeDb()
    expect(await searchKnowledge(db, 'acct', { embeddingsApiKey: null }, '   ', { audience: 'ai' })).toEqual([])
  })
})

describe('searchKnowledge — meaning path', () => {
  it('uses the embeddings service and drops distant matches', async () => {
    h.embedTexts.mockResolvedValue([[0.1, 0.2]])
    const { db, state } = makeDb()
    state.semantic = [sem('c1', 'A', 'close', 0.3), sem('c2', 'B', 'far', 0.8)]
    const hits = await searchKnowledge(
      db, 'acct', { embeddingsApiKey: 'k', embeddingsBaseUrl: 'https://emb.example/v1', embeddingsModel: 'm' },
      'money back', { audience: 'ai' },
    )
    expect(hits.map((x) => x.chunkId)).toEqual(['c1'])
    expect(h.embedTexts).toHaveBeenCalledWith('k', ['money back'], { baseUrl: 'https://emb.example/v1', model: 'm' })
    expect(state.rpcCalls.find((c) => c.name === 'kb_match_semantic')!.args.p_query_embedding).toBe('[0.1,0.2]')
  })

  it('falls back to keywords when embedding fails', async () => {
    h.embedTexts.mockRejectedValue(new Error('boom'))
    const { db, state } = makeDb()
    state.fts = [fts('c1', 'Refunds', 'Refunds\n\nrefund policy')]
    const hits = await searchKnowledge(db, 'acct', { embeddingsApiKey: 'k' }, 'refund', { audience: 'ai' })
    expect(hits.map((x) => x.chunkId)).toEqual(['c1'])
  })

  it('ranks a chunk found by both searches above one found by one', async () => {
    h.embedTexts.mockResolvedValue([[1]])
    const { db, state } = makeDb()
    state.semantic = [sem('only-sem', 'A', 'a refund', 0.2), sem('both', 'B', 'b refund', 0.3)]
    state.fts = [fts('both', 'B', 'b refund'), fts('only-fts', 'C', 'c refund')]
    const hits = await searchKnowledge(db, 'acct', { embeddingsApiKey: 'k' }, 'refund', { audience: 'ai' })
    expect(hits[0].chunkId).toBe('both')
  })
})

describe('searchKnowledge — includeBelowCutoff (the test box)', () => {
  it('marks weak keyword matches instead of dropping them, listed after the good ones', async () => {
    const { db, state } = makeDb()
    state.fts = [
      fts('good', 'Pricing', 'Pricing\n\nThe pro plan invoice arrives yearly.'),
      fts('weak', 'Shipping', 'Shipping takes days.'),
    ]
    const q = 'how many days until my invoice arrives for the pro plan yearly subscription'
    const plain = await searchKnowledge(db, 'acct', { embeddingsApiKey: null }, q, { audience: 'ai' })
    expect(plain.map((x) => x.chunkId)).toEqual(['good'])
    expect(plain[0].belowCutoff).toBeUndefined()

    const debug = await searchKnowledge(db, 'acct', { embeddingsApiKey: null }, q, { audience: 'ai', includeBelowCutoff: true })
    expect(debug.map((x) => [x.chunkId, x.belowCutoff ?? false])).toEqual([['good', false], ['weak', true]])
    expect(debug[1].via).toBe('keyword')
    expect(debug[1].raw).toBeGreaterThan(0)
  })

  it('keeps distant meaning matches with their similarity', async () => {
    h.embedTexts.mockResolvedValue([[0.1]])
    const { db, state } = makeDb()
    state.semantic = [sem('close', 'A', 'close', 0.3), sem('far', 'B', 'far', 0.8), sem('farther', 'C', 'farther', 0.9)]
    const hits = await searchKnowledge(db, 'acct', { embeddingsApiKey: 'k' }, 'money back', {
      audience: 'ai',
      includeBelowCutoff: true,
    })
    expect(hits.map((x) => [x.chunkId, x.belowCutoff ?? false])).toEqual([
      ['close', false],
      ['far', true],
      ['farther', true],
    ])
    expect(hits[0].raw).toBeCloseTo(0.7)
    expect(hits[1].raw).toBeCloseTo(0.2)
  })

  it('never lists a passage twice', async () => {
    h.embedTexts.mockResolvedValue([[0.1]])
    const { db, state } = makeDb()
    state.semantic = [sem('c1', 'A', 'refund policy', 0.3)]
    state.fts = [fts('c1', 'A', 'refund policy')]
    const hits = await searchKnowledge(db, 'acct', { embeddingsApiKey: 'k' }, 'refund', { audience: 'ai', includeBelowCutoff: true })
    expect(hits.map((x) => x.chunkId)).toEqual(['c1'])
  })
})

describe('searchKnowledge — shaping', () => {
  it('keeps at most two chunks per article', async () => {
    const { db, state } = makeDb()
    state.fts = [fts('1', 'D', 'refund a'), fts('2', 'D', 'refund b'), fts('3', 'D', 'refund c'), fts('4', 'E', 'refund d')]
    const hits = await searchKnowledge(db, 'acct', { embeddingsApiKey: null }, 'refund', { audience: 'ai', k: 5 })
    expect(hits.filter((x) => x.documentId === 'D')).toHaveLength(2)
    expect(hits.map((x) => x.documentId)).toContain('E')
  })

  it('caps the result at k', async () => {
    const { db, state } = makeDb()
    state.fts = Array.from({ length: 8 }, (_, i) => fts(`c${i}`, `D${i}`, 'refund'))
    const hits = await searchKnowledge(db, 'acct', { embeddingsApiKey: null }, 'refund', { audience: 'ai', k: 3 })
    expect(hits).toHaveLength(3)
  })

  it('nudges an article in the customer language ahead of an equal one', async () => {
    const { db, state } = makeDb()
    // Same rank position would tie; here the Malay one is second by list order.
    state.fts = [fts('en', 'A', 'bayaran balik', 0.5, 'en'), fts('ms', 'B', 'bayaran balik', 0.5, 'ms')]
    const hits = await searchKnowledge(db, 'acct', { embeddingsApiKey: null }, 'bayaran balik', { audience: 'ai', language: 'ms' })
    expect(hits[0].chunkId).toBe('ms')
  })
})

describe('retrieveKnowledge', () => {
  it('returns just the excerpt text for the AI audience', async () => {
    const { db, state } = makeDb()
    state.fts = [fts('c1', 'Refunds', 'Refunds\n\nrefund policy')]
    expect(await retrieveKnowledge(db, 'acct', { embeddingsApiKey: null }, 'refund')).toEqual(['Refunds\n\nrefund policy'])
    expect(state.rpcCalls[0].args.p_audience).toBe('ai')
  })
})

describe('ingestDocument', () => {
  const doc = { id: 'doc-1', title: 'Refunds', content: 'Para one.\n\nPara two.', status: 'published' as const }

  it('prefixes each chunk with the title and embeds it', async () => {
    h.embedTexts.mockResolvedValue([[1, 2]])
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', { embeddingsApiKey: 'k' }, doc)
    expect(state.deletedFor).toBe('doc-1')
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted![0]).toMatchObject({
      document_id: 'doc-1',
      account_id: 'acct',
      content: 'Refunds\n\nPara one.\n\nPara two.',
      embedding: '[1,2]',
    })
    expect(h.embedTexts.mock.calls[0][1]).toEqual(['Refunds\n\nPara one.\n\nPara two.'])
  })

  it('indexes keyword-only when there is no embeddings key', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', { embeddingsApiKey: null }, doc)
    expect(h.embedTexts).not.toHaveBeenCalled()
    expect(state.inserted![0].embedding).toBeNull()
  })

  it('never indexes a draft (and clears any old chunks)', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', { embeddingsApiKey: 'k' }, { ...doc, status: 'draft' })
    expect(state.deletedFor).toBe('doc-1')
    expect(state.inserted).toBeNull()
    expect(h.embedTexts).not.toHaveBeenCalled()
  })

  it('still stores keyword chunks when embedding fails, then rethrows', async () => {
    h.embedTexts.mockRejectedValue(new Error('rate limited'))
    const { db, state } = makeDb()
    await expect(ingestDocument(db, 'acct', { embeddingsApiKey: 'k' }, doc)).rejects.toThrow('rate limited')
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted![0].embedding).toBeNull()
  })

  it('passes the embeddings URL and model through', async () => {
    h.embedTexts.mockResolvedValue([[1]])
    const { db } = makeDb()
    await ingestDocument(db, 'acct', { embeddingsApiKey: 'k', embeddingsBaseUrl: 'https://e.example/v1', embeddingsModel: 'mm' }, doc)
    expect(h.embedTexts.mock.calls[0][2]).toEqual({ baseUrl: 'https://e.example/v1', model: 'mm' })
  })
})

describe('usage and gap logging', () => {
  it('logs one citation per article with its best score', async () => {
    const { db, state } = makeDb()
    await logKnowledgeUse(db, {
      accountId: 'acct', conversationId: 'conv', mode: 'auto_reply',
      hits: [
        { chunkId: '1', documentId: 'D', title: 'D', category: null, language: 'en', content: 'x', score: 0.2, via: 'keyword' },
        { chunkId: '2', documentId: 'D', title: 'D', category: null, language: 'en', content: 'y', score: 0.9, via: 'meaning' },
      ],
    })
    expect(state.insertedInto).toBe('ai_knowledge_citations')
    expect(state.inserted).toEqual([{ account_id: 'acct', document_id: 'D', conversation_id: 'conv', mode: 'auto_reply', score: 0.9 }])
  })

  it('logs nothing when there were no hits', async () => {
    const { db, state } = makeDb()
    await logKnowledgeUse(db, { accountId: 'a', conversationId: null, mode: 'draft', hits: [] })
    expect(state.inserted).toBeNull()
  })

  it('sends the gap question to the RPC', async () => {
    const { db, state } = makeDb()
    await logKnowledgeGap(db, 'acct', '  Do you support LINE?  ', 'conv')
    expect(state.rpcCalls[0]).toEqual({
      name: 'kb_log_gap',
      args: { p_account_id: 'acct', p_question: 'Do you support LINE?', p_conversation_id: 'conv' },
    })
  })

  it('ignores a blank gap question', async () => {
    const { db, state } = makeDb()
    await logKnowledgeGap(db, 'acct', '   ', null)
    expect(state.rpcCalls).toHaveLength(0)
  })
})
