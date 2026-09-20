import { MAX_SEMANTIC_DISTANCE, type KnowledgeHit } from '@/lib/ai/knowledge'
import { stripTitle } from './excerpts'
import type { KnowledgeTestPassage, KnowledgeTestResponse } from '@/lib/knowledge-types'

// ============================================================
// The "Test it: would the AI find this?" box. It runs the same retrieval the
// AI uses and shows which passages would be sent (`used`) and which matched
// but fell under the relevance cut-off.
// ============================================================

const PASSAGE_CHARS = 600

export function cutoffNote(mode: 'meaning' | 'keyword'): string {
  const minSimilarity = (1 - MAX_SEMANTIC_DISTANCE).toFixed(2)
  return mode === 'meaning'
    ? `${minSimilarity} similarity (meaning) / at least a quarter of the question's words (keyword)`
    : "at least a quarter of the question's words (keyword only: meaning search is not set up)"
}

export function toTestResponse(hits: KnowledgeHit[], mode: 'meaning' | 'keyword'): KnowledgeTestResponse {
  const passages: KnowledgeTestPassage[] = hits.map((h) => ({
    document_id: h.documentId,
    title: h.title,
    text: stripTitle(h.content, h.title).slice(0, PASSAGE_CHARS),
    // The passage's own match strength (0-1), which reads the same in every
    // search; the fused ranking score is not meaningful on its own.
    score: Math.round((h.raw ?? h.score) * 100) / 100,
    used: !h.belowCutoff,
    via: h.via,
  }))
  return { passages, mode, cutoff_note: cutoffNote(mode) }
}
