import { describe, expect, it } from 'vitest'

import { linkifySegments } from './linkify'

describe('linkifySegments', () => {
  it('returns [] for empty input', () => {
    expect(linkifySegments('')).toEqual([])
  })

  it('returns a single text segment when there are no links', () => {
    expect(linkifySegments('just a normal message')).toEqual([
      { type: 'text', text: 'just a normal message' },
    ])
  })

  it('splits a full http(s) URL into text/link/text', () => {
    expect(linkifySegments('see https://vircle.com/pricing today')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'link', text: 'https://vircle.com/pricing', href: 'https://vircle.com/pricing' },
      { type: 'text', text: ' today' },
    ])
  })

  it('keeps the original bare www. text but adds a scheme to href', () => {
    expect(linkifySegments('check out www.vircle.com')).toEqual([
      { type: 'text', text: 'check out ' },
      { type: 'link', text: 'www.vircle.com', href: 'https://www.vircle.com' },
    ])
  })

  it('leaves trailing punctuation as plain text after the link', () => {
    expect(linkifySegments('see www.vircle.com.')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'link', text: 'www.vircle.com', href: 'https://www.vircle.com' },
      { type: 'text', text: '.' },
    ])
  })

  it('handles a link with nothing around it', () => {
    expect(linkifySegments('https://vircle.com')).toEqual([
      { type: 'link', text: 'https://vircle.com', href: 'https://vircle.com' },
    ])
  })

  it('handles multiple links in one body', () => {
    expect(linkifySegments('https://a.com and www.b.com')).toEqual([
      { type: 'link', text: 'https://a.com', href: 'https://a.com' },
      { type: 'text', text: ' and ' },
      { type: 'link', text: 'www.b.com', href: 'https://www.b.com' },
    ])
  })
})
