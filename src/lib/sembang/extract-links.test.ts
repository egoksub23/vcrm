import { describe, expect, it } from 'vitest'

import { extractLinks } from './extract-links'

describe('extractLinks', () => {
  it('returns an empty array for a body with no links', () => {
    expect(extractLinks('just a normal message')).toEqual([])
  })

  it('matches a full http(s) URL', () => {
    expect(extractLinks('check out https://vircle.com/pricing')).toEqual([
      'https://vircle.com/pricing',
    ])
  })

  it('matches a bare www. address with no scheme, adding https://', () => {
    expect(extractLinks('check out www.vircle.com')).toEqual(['https://www.vircle.com'])
  })

  it('does not double-count the www. inside a scheme URL', () => {
    expect(extractLinks('check out https://www.vircle.com')).toEqual([
      'https://www.vircle.com',
    ])
  })

  it('does not match a bare domain without the www. prefix', () => {
    expect(extractLinks('see Node.js or v2.0 release notes')).toEqual([])
  })

  it('strips common trailing punctuation', () => {
    expect(extractLinks('see www.vircle.com.')).toEqual(['https://www.vircle.com'])
    expect(extractLinks('(https://vircle.com)')).toEqual(['https://vircle.com'])
  })

  it('preserves reading order across mixed scheme and bare links', () => {
    expect(extractLinks('first www.a.com then https://b.com')).toEqual([
      'https://www.a.com',
      'https://b.com',
    ])
  })

  it('returns one entry per link, in order, when several appear in one body', () => {
    expect(extractLinks('https://a.com and www.b.com')).toEqual([
      'https://a.com',
      'https://www.b.com',
    ])
  })
})
