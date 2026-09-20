import { describe, it, expect } from 'vitest'
import { buildInsights, type InsightDoc } from './insights'

const doc = (id: string, over: Partial<InsightDoc> = {}): InsightDoc => ({
  id,
  title: `Article ${id}`,
  status: 'published',
  use_in_ai: true,
  updated_at: `2026-01-0${id.length}T00:00:00Z`,
  ...over,
})

describe('buildInsights', () => {
  it('ranks the most used articles and drops unknown ids and zero counts', () => {
    const r = buildInsights({
      windowDays: 30,
      docs: [doc('a'), doc('b'), doc('c')],
      uses: new Map([['a', 2], ['b', 9], ['c', 0], ['ghost', 50]]),
      resolvedGaps: [],
    })
    expect(r.window_days).toBe(30)
    expect(r.most_used).toEqual([
      { id: 'b', title: 'Article b', uses: 9 },
      { id: 'a', title: 'Article a', uses: 2 },
    ])
  })

  it('lists only published, AI-enabled articles with no use as never used, oldest first', () => {
    const r = buildInsights({
      windowDays: 30,
      docs: [
        doc('a', { updated_at: '2026-03-01T00:00:00Z' }),
        doc('b', { updated_at: '2026-01-01T00:00:00Z' }),
        doc('c', { status: 'draft' }),
        doc('d', { use_in_ai: false }),
        doc('e'),
      ],
      uses: new Map([['e', 1]]),
      resolvedGaps: [],
    })
    expect(r.never_used.map((d) => d.id)).toEqual(['b', 'a'])
  })

  it('adds up handoffs per article from the questions it resolved', () => {
    const r = buildInsights({
      windowDays: 30,
      docs: [doc('a'), doc('b')],
      uses: new Map(),
      resolvedGaps: [
        { resolved_document_id: 'a', times_asked: 3 },
        { resolved_document_id: 'a', times_asked: 2 },
        { resolved_document_id: 'b', times_asked: 4 },
        { resolved_document_id: null, times_asked: 9 },
        { resolved_document_id: 'gone', times_asked: 9 },
      ],
    })
    expect(r.handoff_fixes).toEqual([
      { id: 'a', title: 'Article a', handoffs: 5 },
      { id: 'b', title: 'Article b', handoffs: 4 },
    ])
  })

  it('caps the lists', () => {
    const docs = Array.from({ length: 40 }, (_, i) => doc(`d${i}`, { updated_at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z` }))
    const uses = new Map(docs.map((d, i) => [d.id, i + 1] as const))
    const r = buildInsights({ windowDays: 7, docs, uses, resolvedGaps: [] })
    expect(r.most_used).toHaveLength(10)
    expect(r.most_used[0].uses).toBe(40)
    const none = buildInsights({ windowDays: 7, docs, uses: new Map(), resolvedGaps: [] })
    expect(none.never_used).toHaveLength(20)
  })
})
