import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig } from './types'
import { chunkText } from './chunk'
import { embedTexts, toVectorLiteral } from './embeddings'
import { dedupeAgainst, dedupeByTranslationGroup } from '@/lib/knowledge/translate'
import {
  buildFtsQuery,
  detectLanguage,
  passesKeywordFloor,
  termHits,
  type KbLanguage,
} from './knowledge-query'

// ============================================================
// Knowledge base: ingest (chunk + optionally embed) and hybrid
// retrieve (meaning search when an embeddings service is set up, plus
// keyword search), shared by the AI (draft, auto-reply, playground) and
// the agents' search box in the inbox.
//
// Only PUBLISHED articles are ever indexed or returned. The AI audience
// additionally requires `use_in_ai` — enforced in SQL (migration 073),
// not just here.
// ============================================================

export type KnowledgeAudience = 'ai' | 'agent'
export type KnowledgeUseMode = 'auto_reply' | 'draft' | 'playground' | 'agent_search'

export type EmbeddingsSettings = Pick<
  AiConfig,
  'embeddingsApiKey' | 'embeddingsBaseUrl' | 'embeddingsModel'
>

export interface KnowledgeHit {
  chunkId: string
  documentId: string
  title: string
  category: string | null
  language: KbLanguage
  content: string
  /** The base article when this passage is from a translation. Retrieval keeps
   *  one article per translation group, so a translation and its base are
   *  never both used. */
  translationOf?: string | null
  /** Higher is better; comparable only within one result list. */
  score: number
  via: 'meaning' | 'keyword'
  /** How well the passage matched on its own, 0 to 1: cosine similarity for
   *  a meaning match, the share of the question's terms found for a keyword
   *  match. Unlike `score` it means the same thing across searches. */
  raw?: number
  /** Only set on results asked for with `includeBelowCutoff`: the passage
   *  matched but was too weak for the AI to be shown it. */
  belowCutoff?: boolean
}

interface FtsRow {
  chunk_id: string
  document_id: string
  title: string
  category: string | null
  language: KbLanguage
  content: string
  rank: number
  translation_of?: string | null
}
interface SemanticRow extends Omit<FtsRow, 'rank'> {
  distance: number
}

/** Cosine distance above which a meaning match is treated as unrelated. */
export const MAX_SEMANTIC_DISTANCE = 0.62
/** Never send more than this many characters of excerpts to a model. */
export const MAX_EXCERPT_CHARS = 6000
/** At most this many chunks from one article, so results stay varied. */
const MAX_CHUNKS_PER_DOC = 2
/** Reciprocal-rank-fusion constant. */
const RRF_K = 60
/** Small nudge for an article already in the customer's language. */
const LANGUAGE_BOOST = 0.006

export interface IngestDoc {
  id: string
  title: string
  content: string
  status: 'draft' | 'published'
}

/**
 * (Re)build the chunks for one article. Drafts get no chunks (they must
 * never be searchable); a published article's chunks each start with its
 * title so a passage keeps the context of what it is about. When the
 * account has an embeddings service, each chunk is embedded too.
 *
 * An embedding failure never stops the chunks being stored: the article
 * stays searchable by keyword, and the error is rethrown afterwards so
 * the route can warn.
 */
export async function ingestDocument(
  db: SupabaseClient,
  accountId: string,
  config: Partial<EmbeddingsSettings>,
  doc: IngestDoc,
): Promise<void> {
  // Replace, don't append — re-ingest must be idempotent.
  const { error: delErr } = await db
    .from('ai_knowledge_chunks')
    .delete()
    .eq('document_id', doc.id)
  if (delErr) throw delErr

  if (doc.status !== 'published') return

  const chunks = chunkText(doc.content).map((c) => `${doc.title}\n\n${c}`)
  if (chunks.length === 0) return

  let embeddings: number[][] | null = null
  let embedError: unknown = null
  if (config.embeddingsApiKey) {
    try {
      embeddings = await embedTexts(config.embeddingsApiKey, chunks, {
        baseUrl: config.embeddingsBaseUrl,
        model: config.embeddingsModel,
      })
    } catch (err) {
      embedError = err
    }
  }

  const rows = chunks.map((content, i) => ({
    document_id: doc.id,
    account_id: accountId,
    chunk_index: i,
    content,
    embedding: embeddings ? toVectorLiteral(embeddings[i]) : null,
  }))

  const { error: insErr } = await db.from('ai_knowledge_chunks').insert(rows)
  if (insErr) throw insErr

  if (embedError) throw embedError
}

export interface SearchOptions {
  audience: KnowledgeAudience
  k?: number
  /** The customer's language, when known; the query's own language is
   *  used otherwise. Articles in it rank slightly higher. */
  language?: KbLanguage | null
  /** Also return passages that fell under the relevance cut-off, marked
   *  `belowCutoff` and listed after the ones that made it. Only the "test it"
   *  box asks for this; the AI paths never do, so their results are unchanged. */
  includeBelowCutoff?: boolean
}

/**
 * Search the knowledge base. Best-effort: any failure (no articles, an
 * embeddings error, an RPC error) degrades to fewer or no results and
 * never throws into the draft / auto-reply / inbox path.
 */
export async function searchKnowledge(
  db: SupabaseClient,
  accountId: string,
  config: Partial<EmbeddingsSettings>,
  queryText: string,
  opts: SearchOptions,
): Promise<KnowledgeHit[]> {
  const query = queryText.trim()
  const k = opts.k ?? 5
  if (!query || k <= 0) return []

  // No published articles → skip the query embedding and both RPCs.
  try {
    const { count, error } = await db
      .from('ai_knowledge_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
    if (error || !count) return []
  } catch {
    return []
  }

  const wanted = k * 3
  const meaning: KnowledgeHit[] = []
  const keyword: KnowledgeHit[] = []
  const below: KnowledgeHit[] = []

  if (config.embeddingsApiKey) {
    try {
      const [queryEmbedding] = await embedTexts(config.embeddingsApiKey, [query], {
        baseUrl: config.embeddingsBaseUrl,
        model: config.embeddingsModel,
      })
      if (queryEmbedding) {
        const { data, error } = await db.rpc('kb_match_semantic', {
          p_account_id: accountId,
          p_query_embedding: toVectorLiteral(queryEmbedding),
          p_audience: opts.audience,
          p_match_count: wanted,
        })
        if (!error && Array.isArray(data)) {
          for (const row of data as SemanticRow[]) {
            const similarity = 1 - row.distance
            if (row.distance > MAX_SEMANTIC_DISTANCE) {
              if (opts.includeBelowCutoff) {
                below.push({ ...toHit(row), score: similarity, raw: similarity, via: 'meaning', belowCutoff: true })
              }
              continue
            }
            meaning.push({ ...toHit(row), score: similarity, raw: similarity, via: 'meaning' })
          }
        }
      }
    } catch (err) {
      console.error('[knowledge] meaning search failed, falling back to keywords:', err)
    }
  }

  const ftsQuery = buildFtsQuery(query)
  if (ftsQuery) {
    try {
      const { data, error } = await db.rpc('kb_match_fts', {
        p_account_id: accountId,
        p_query: ftsQuery,
        p_audience: opts.audience,
        p_match_count: wanted,
      })
      if (!error && Array.isArray(data)) {
        for (const row of data as FtsRow[]) {
          const { hits: found, total } = termHits(row.content, query)
          const coverage = total ? found / total : 0
          if (!passesKeywordFloor(row.content, query)) {
            if (opts.includeBelowCutoff) {
              below.push({ ...toHit(row), score: row.rank, raw: coverage, via: 'keyword', belowCutoff: true })
            }
            continue
          }
          keyword.push({ ...toHit(row), score: row.rank, raw: coverage, via: 'keyword' })
        }
      }
    } catch (err) {
      console.error('[knowledge] keyword search failed:', err)
    }
  }

  const customerLanguage = opts.language ?? detectLanguage(query)
  const used = fuse(meaning, keyword, customerLanguage, k)
  if (!opts.includeBelowCutoff) return used

  const usedChunks = new Set(used.map((h) => h.chunkId))
  const weak = new Map<string, KnowledgeHit>()
  for (const h of below) {
    if (usedChunks.has(h.chunkId)) continue
    const existing = weak.get(h.chunkId)
    if (!existing || (h.raw ?? 0) > (existing.raw ?? 0)) weak.set(h.chunkId, h)
  }
  // A weak passage may not bring in a translation (or the base) of an article
  // that already made it into the result.
  const weakest = dedupeAgainst(
    Array.from(weak.values()).sort((a, b) => (b.raw ?? 0) - (a.raw ?? 0)),
    used,
    customerLanguage,
  ).slice(0, k)
  return [...used, ...weakest]
}

function toHit(row: Omit<FtsRow, 'rank'>): Omit<KnowledgeHit, 'score' | 'via'> {
  return {
    chunkId: row.chunk_id,
    documentId: row.document_id,
    title: row.title,
    category: row.category,
    language: row.language,
    content: row.content,
    translationOf: row.translation_of ?? null,
  }
}

/** Merge the two ranked lists (reciprocal rank fusion), nudge articles in
 *  the customer's language, keep the result varied, and cap it. */
function fuse(
  meaning: KnowledgeHit[],
  keyword: KnowledgeHit[],
  language: KbLanguage | null,
  k: number,
): KnowledgeHit[] {
  const merged = new Map<string, KnowledgeHit & { fused: number }>()
  const add = (list: KnowledgeHit[]) =>
    list.forEach((hit, rank) => {
      const gain = 1 / (RRF_K + rank + 1)
      const existing = merged.get(hit.chunkId)
      if (existing) existing.fused += gain
      else merged.set(hit.chunkId, { ...hit, fused: gain })
    })
  add(meaning)
  add(keyword)

  const ranked = Array.from(merged.values())
    .map((h) => ({ ...h, fused: h.fused + (language && h.language === language ? LANGUAGE_BOOST : 0) }))
    .sort((a, b) => b.fused - a.fused)

  // One article per translation group (the customer's language wins), decided
  // before the per-article cap so a translation cannot crowd out other topics.
  const candidates = dedupeByTranslationGroup(ranked, language)

  const perDoc = new Map<string, number>()
  const out: KnowledgeHit[] = []
  let chars = 0
  for (const hit of candidates) {
    const n = perDoc.get(hit.documentId) ?? 0
    if (n >= MAX_CHUNKS_PER_DOC) continue
    if (out.length > 0 && chars + hit.content.length > MAX_EXCERPT_CHARS) continue
    perDoc.set(hit.documentId, n + 1)
    chars += hit.content.length
    const { fused, ...rest } = hit
    out.push({ ...rest, score: fused })
    if (out.length >= k) break
  }
  return out
}

/**
 * The excerpts for an AI prompt: published, AI-enabled articles only.
 * Kept for callers that only need the text; use `searchKnowledge` when
 * the sources matter (citations, gaps).
 */
export async function retrieveKnowledge(
  db: SupabaseClient,
  accountId: string,
  config: Partial<EmbeddingsSettings>,
  queryText: string,
  k = 5,
  language?: KbLanguage | null,
): Promise<string[]> {
  const hits = await searchKnowledge(db, accountId, config, queryText, {
    audience: 'ai',
    k,
    language,
  })
  return hits.map((h) => h.content)
}

/** Record which articles were used (feeds "AI uses" on the library page).
 *  Fire-and-forget safe: swallows its own errors. */
export async function logKnowledgeUse(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string | null
    mode: KnowledgeUseMode
    hits: KnowledgeHit[]
  },
): Promise<void> {
  try {
    const best = new Map<string, number>()
    for (const h of args.hits) {
      best.set(h.documentId, Math.max(best.get(h.documentId) ?? 0, h.score))
    }
    if (best.size === 0) return
    const { error } = await db.from('ai_knowledge_citations').insert(
      Array.from(best, ([document_id, score]) => ({
        account_id: args.accountId,
        document_id,
        conversation_id: args.conversationId,
        mode: args.mode,
        score,
      })),
    )
    if (error) console.error('[knowledge] citation log failed:', error)
  } catch (err) {
    console.error('[knowledge] citation log failed:', err)
  }
}

/** Record a question the AI had no article for (service-role only). */
export async function logKnowledgeGap(
  db: SupabaseClient,
  accountId: string,
  question: string,
  conversationId: string | null,
): Promise<void> {
  try {
    const text = question.trim()
    if (!text) return
    const { error } = await db.rpc('kb_log_gap', {
      p_account_id: accountId,
      p_question: text,
      p_conversation_id: conversationId,
    })
    if (error) console.error('[knowledge] gap log failed:', error)
  } catch (err) {
    console.error('[knowledge] gap log failed:', err)
  }
}
