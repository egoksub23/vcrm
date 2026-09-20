import { describe, expect, it } from 'vitest'

import type { KnowledgeTestPassage } from '@/lib/knowledge-types'
import { summariseTest } from './kb-test-utils'

const p = (document_id: string, used: boolean): KnowledgeTestPassage => ({
  document_id,
  title: 'T',
  text: 'x',
  score: 0.5,
  used,
  via: 'keyword',
})

describe('summariseTest', () => {
  it('reports used when any passage of the article reaches the AI', () => {
    expect(summariseTest([p('a', false), p('a', true), p('b', true)], 'a')).toEqual({ thisArticle: 'used', usedCount: 2 })
  })
  it('reports below when the article only matched under the cut-off', () => {
    expect(summariseTest([p('a', false), p('b', true)], 'a').thisArticle).toBe('below')
  })
  it('reports missing when the article did not come up', () => {
    expect(summariseTest([p('b', true)], 'a').thisArticle).toBe('missing')
    expect(summariseTest([], 'a').thisArticle).toBe('missing')
  })
  it('treats an unsaved article as missing', () => {
    expect(summariseTest([p('b', true)], null).thisArticle).toBe('missing')
  })
})
