import { describe, it, expect } from 'vitest'
import { cutoffNote, toTestResponse } from './test-search'
import { stripTitle } from './excerpts'
import type { KnowledgeHit } from '@/lib/ai/knowledge'

const hit = (over: Partial<KnowledgeHit>): KnowledgeHit => ({
  chunkId: 'c1',
  documentId: 'd1',
  title: 'Refunds',
  category: null,
  language: 'en',
  content: 'Refunds\n\nFull refund within 30 days.',
  score: 0.016,
  via: 'keyword',
  ...over,
})

describe('stripTitle', () => {
  it('removes the leading title only', () => {
    expect(stripTitle('Refunds\n\nBody', 'Refunds')).toBe('Body')
    expect(stripTitle('Body only', 'Refunds')).toBe('Body only')
  })
})

describe('toTestResponse', () => {
  it('marks passages under the cut-off as not used and prefers the raw match strength', () => {
    const res = toTestResponse(
      [
        hit({ raw: 0.7149, via: 'meaning' }),
        hit({ chunkId: 'c2', documentId: 'd2', title: 'Shipping', content: 'Shipping\n\nTakes days.', raw: 0.2, belowCutoff: true }),
      ],
      'meaning',
    )
    expect(res.mode).toBe('meaning')
    expect(res.passages).toEqual([
      { document_id: 'd1', title: 'Refunds', text: 'Full refund within 30 days.', score: 0.71, used: true, via: 'meaning' },
      { document_id: 'd2', title: 'Shipping', text: 'Takes days.', score: 0.2, used: false, via: 'keyword' },
    ])
    expect(res.cutoff_note).toBe(cutoffNote('meaning'))
  })

  it('falls back to the score when a hit has no raw value, and clips long text', () => {
    const res = toTestResponse([hit({ content: 'Refunds\n\n' + 'x'.repeat(2000) })], 'keyword')
    expect(res.passages[0].score).toBe(0.02)
    expect(res.passages[0].text).toHaveLength(600)
  })

  it('says what the cut-off is for both modes', () => {
    expect(cutoffNote('meaning')).toContain('0.38')
    expect(cutoffNote('keyword')).toContain('keyword only')
  })

  it('handles no results', () => {
    expect(toTestResponse([], 'keyword').passages).toEqual([])
  })
})
