import { describe, expect, it } from 'vitest'

import { MAX_IMPORT_PAIRS, capPairs, parseCsvPairs, parsePastedPairs } from './knowledge-import-parse'

describe('parsePastedPairs', () => {
  it('reads one "Question | Answer" pair per line', () => {
    const r = parsePastedPairs('Refund window? | 30 days\nDo you ship? | Yes, worldwide')
    expect(r.pairs).toEqual([
      { question: 'Refund window?', answer: '30 days' },
      { question: 'Do you ship?', answer: 'Yes, worldwide' },
    ])
    expect(r.skipped).toBe(0)
  })

  it('splits on the first pipe only, so an answer may contain one', () => {
    expect(parsePastedPairs('Plans? | Free | Pro | Team').pairs).toEqual([
      { question: 'Plans?', answer: 'Free | Pro | Team' },
    ])
  })

  it('accepts a tab, as pasted from two spreadsheet columns', () => {
    expect(parsePastedPairs('Hours?\t9 to 6').pairs).toEqual([{ question: 'Hours?', answer: '9 to 6' }])
  })

  it('ignores blank lines and CRLF, and counts lines it cannot read', () => {
    const r = parsePastedPairs('A | B\r\n\r\nno separator here\r\n | missing question\r\nC | \r\nD | E\r\n')
    expect(r.pairs).toEqual([
      { question: 'A', answer: 'B' },
      { question: 'D', answer: 'E' },
    ])
    expect(r.skipped).toBe(3)
  })

  it('returns nothing for empty input', () => {
    expect(parsePastedPairs('  \n ')).toEqual({ pairs: [], skipped: 0 })
  })
})

describe('parseCsvPairs', () => {
  it('finds the question and answer columns by header, in any order', () => {
    const r = parseCsvPairs('id,Answer,Question\n1,30 days,Refund window?\n2,Yes,Do you ship?')
    expect(r.missingColumns).toBe(false)
    expect(r.pairs).toEqual([
      { question: 'Refund window?', answer: '30 days' },
      { question: 'Do you ship?', answer: 'Yes' },
    ])
  })

  it('handles quoted cells with commas and line breaks, and a BOM', () => {
    const r = parseCsvPairs('﻿question,answer\r\n"Plans, prices?","Free\nPro"\r\n')
    expect(r.pairs).toEqual([{ question: 'Plans, prices?', answer: 'Free\nPro' }])
  })

  it('accepts common header aliases', () => {
    expect(parseCsvPairs('Q,A\nHi?,Hello').pairs).toHaveLength(1)
    expect(parseCsvPairs('prompt,response\nHi?,Hello').pairs).toHaveLength(1)
  })

  it('skips rows missing either side', () => {
    const r = parseCsvPairs('question,answer\nA,B\nC,\n,D\nE,F')
    expect(r.pairs).toHaveLength(2)
    expect(r.skipped).toBe(2)
  })

  it('flags a file without question and answer columns', () => {
    expect(parseCsvPairs('name,email\nA,b@c.d')).toEqual({ pairs: [], skipped: 0, missingColumns: true })
    expect(parseCsvPairs('').missingColumns).toBe(true)
  })
})

describe('capPairs', () => {
  const many = Array.from({ length: MAX_IMPORT_PAIRS + 5 }, (_, i) => ({ question: `q${i}`, answer: 'a' }))

  it('keeps everything under the cap', () => {
    expect(capPairs(many.slice(0, 3))).toEqual({ pairs: many.slice(0, 3), truncated: false })
  })

  it('cuts to the cap and says so', () => {
    const r = capPairs(many)
    expect(r.pairs).toHaveLength(MAX_IMPORT_PAIRS)
    expect(r.truncated).toBe(true)
  })
})
