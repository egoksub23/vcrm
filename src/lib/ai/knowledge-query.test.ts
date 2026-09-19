import { describe, it, expect } from 'vitest'
import {
  buildFtsQuery,
  detectLanguage,
  extractTerms,
  normalizeLanguage,
  passesKeywordFloor,
  termHits,
} from './knowledge-query'

describe('extractTerms', () => {
  it('drops English stopwords and one-letter words, keeps digits', () => {
    const { words } = extractTerms('Can I get a refund after 30 days for 5 agents?')
    expect(words).toEqual(['refund', 'after', '30', 'days', '5', 'agents'])
  })

  it('drops Bahasa Melayu stopwords', () => {
    const { words } = extractTerms('Boleh saya dapat bayaran balik untuk pelan ini?')
    expect(words).toEqual(['dapat', 'bayaran', 'balik', 'pelan'])
  })

  it('splits Chinese into overlapping pairs', () => {
    expect(extractTerms('退款政策').cjk).toEqual(['退款', '款政', '政策'])
  })

  it('keeps a lone Chinese character on its own', () => {
    expect(extractTerms('价 ok').cjk).toEqual(['价'])
  })

  it('handles mixed Chinese and English', () => {
    const t = extractTerms('Pro 计划多少钱')
    expect(t.words).toEqual(['pro'])
    expect(t.cjk).toEqual(['计划', '划多', '多少', '少钱'])
  })

  it('caps the number of terms', () => {
    const many = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')
    expect(extractTerms(many).words).toHaveLength(24)
  })
})

describe('buildFtsQuery', () => {
  it('ORs the words together', () => {
    expect(buildFtsQuery('refund policy')).toBe('refund | policy')
  })

  it('turns Chinese pairs into phrase queries', () => {
    expect(buildFtsQuery('退款政策')).toBe('(退 <-> 款) | (款 <-> 政) | (政 <-> 策)')
  })

  it('cannot carry tsquery operators from customer text', () => {
    const q = buildFtsQuery("refund & (drop) | !table' <-> x:*")
    expect(q).not.toMatch(/[&!'*:]/)
    expect(q.replace(/\(|\)|<->|\|/g, '').trim().length).toBeGreaterThan(0)
  })

  it('is empty when nothing searchable remains', () => {
    expect(buildFtsQuery('hi, can I?')).toBe('')
    expect(buildFtsQuery('')).toBe('')
  })
})

describe('keyword relevance floor', () => {
  it('counts distinct terms present in a passage', () => {
    expect(termHits('Full refund within 30 days.', 'refund after 30 days')).toEqual({ hits: 3, total: 4 })
  })

  it('passes a short query on a single hit', () => {
    expect(passesKeywordFloor('Our refund policy', 'refund')).toBe(true)
  })

  it('rejects a long query matched on only one common word', () => {
    expect(
      passesKeywordFloor(
        'Shipping takes days.',
        'how many days until my invoice arrives for the pro plan yearly subscription',
      ),
    ).toBe(false)
  })

  it('matches Chinese by pair', () => {
    expect(passesKeywordFloor('退款政策：三十天内全额退款。', '退款政策')).toBe(true)
    expect(passesKeywordFloor('配送时间为三天。', '退款政策')).toBe(false)
  })

  it('never passes an empty query', () => {
    expect(passesKeywordFloor('anything', 'hi')).toBe(false)
  })
})

describe('normalizeLanguage', () => {
  it.each([
    ['en', 'en'],
    ['EN-US', 'en'],
    ['ms', 'ms'],
    ['ms_MY', 'ms'],
    ['zh', 'zh'],
    ['zh-CN', 'zh'],
    ['zh-Hant', 'zh'],
    ['fr', null],
    ['', null],
    [null, null],
  ])('%s → %s', (input, expected) => {
    expect(normalizeLanguage(input as string | null)).toBe(expected)
  })
})

describe('detectLanguage', () => {
  it('detects Chinese by script', () => {
    expect(detectLanguage('请问退款政策是什么？')).toBe('zh')
  })
  it('detects Malay by common words', () => {
    expect(detectLanguage('Boleh saya tahu berapa harga pelan ini?')).toBe('ms')
  })
  it('defaults to English', () => {
    expect(detectLanguage('How much is the Pro plan?')).toBe('en')
  })
  it('returns null when there is nothing to read', () => {
    expect(detectLanguage('  123 ?? ')).toBeNull()
    expect(detectLanguage('')).toBeNull()
  })
})
