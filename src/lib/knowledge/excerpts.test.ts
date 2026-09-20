import { describe, it, expect } from 'vitest'
import { buildSources, groupHitsByArticle } from './excerpts'
import type { KnowledgeHit } from '@/lib/ai/knowledge'

const hit = (chunkId: string, documentId: string, title: string, body: string): KnowledgeHit => ({
  chunkId,
  documentId,
  title,
  category: null,
  language: 'en',
  content: `${title}\n\n${body}`,
  score: 1,
  via: 'keyword',
})

describe('groupHitsByArticle', () => {
  it('makes one excerpt per article in rank order, joining its passages', () => {
    const g = groupHitsByArticle([
      hit('c1', 'A', 'Refunds', 'Within 14 days.'),
      hit('c2', 'B', 'Hours', 'Nine to six.'),
      hit('c3', 'A', 'Refunds', 'Keep the receipt.'),
    ])
    expect(g.documents).toEqual([
      { id: 'A', title: 'Refunds' },
      { id: 'B', title: 'Hours' },
    ])
    expect(g.excerpts).toEqual(['Refunds\n\nWithin 14 days.\n\nKeep the receipt.', 'Hours\n\nNine to six.'])
  })

  it('handles no hits', () => {
    expect(groupHitsByArticle([])).toEqual({ excerpts: [], documents: [] })
  })
})

describe('buildSources', () => {
  const docs = [
    { id: 'A', title: 'Refunds' },
    { id: 'B', title: 'Hours' },
  ]
  it('numbers each article by the excerpt it was cited as, in that order', () => {
    expect(buildSources(['B', 'A'], docs)).toEqual([
      { id: 'A', title: 'Refunds', n: 1 },
      { id: 'B', title: 'Hours', n: 2 },
    ])
  })
  it('ignores ids that are not among the excerpts', () => {
    expect(buildSources(['Z'], docs)).toEqual([])
  })
})
