import { describe, it, expect } from 'vitest'
import { citedDocumentIds, extractCitations } from './citations'

describe('extractCitations', () => {
  it('strips markers and reports what was cited, in order of first mention', () => {
    expect(extractCitations('We open at 9 [2]. Refunds take 14 days [1].', 3)).toEqual({
      text: 'We open at 9. Refunds take 14 days.',
      cited: [2, 1],
    })
  })

  it('handles lists, adjacent markers and full-width brackets', () => {
    expect(extractCitations('Yes [1, 2] and also [1][3].', 3)).toEqual({ text: 'Yes and also.', cited: [1, 2, 3] })
    expect(extractCitations('可以退款【1】。', 2)).toEqual({ text: '可以退款。', cited: [1] })
  })

  it('does not report the same excerpt twice', () => {
    expect(extractCitations('a [1] b [1]', 1).cited).toEqual([1])
  })

  it('leaves a marker for an excerpt that does not exist', () => {
    expect(extractCitations('Choose option [7] or [1].', 2)).toEqual({ text: 'Choose option [7] or.', cited: [1] })
    expect(extractCitations('See [0]', 2)).toEqual({ text: 'See [0]', cited: [] })
  })

  it('does not touch square brackets that are not numbers', () => {
    expect(extractCitations('Use [code] or [1a] or [12345]', 3)).toEqual({ text: 'Use [code] or [1a] or [12345]', cited: [] })
  })

  it('returns text unchanged when there were no excerpts', () => {
    expect(extractCitations('Option [1] is best', 0)).toEqual({ text: 'Option [1] is best', cited: [] })
    expect(extractCitations('', 3)).toEqual({ text: '', cited: [] })
  })

  it('tidies spacing left behind', () => {
    expect(extractCitations('Line one [1]\nLine two [2]\n\n\n[1]', 2).text).toBe('Line one\nLine two')
  })
})

describe('citedDocumentIds', () => {
  const docs = ['docA', 'docB', 'docA', 'docC']
  it('maps cited numbers to distinct articles', () => {
    expect(citedDocumentIds([3, 1, 2], docs)).toEqual(['docA', 'docB'])
  })
  it('falls back to the top excerpt when nothing was cited', () => {
    expect(citedDocumentIds([], docs)).toEqual(['docA'])
    expect(citedDocumentIds([], [])).toEqual([])
  })
  it('ignores numbers outside the list', () => {
    expect(citedDocumentIds([9], docs)).toEqual([])
  })
})
