import { describe, expect, it } from 'vitest'

import { escapeLike, tokensEqual } from './safe-compare'

const BACKSLASH = String.fromCharCode(92)
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g

/** A minimal SQL LIKE: backslash escapes the next character, % is any run, _ is any one character. */
function like(pattern: string, value: string): boolean {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === BACKSLASH) re += (pattern[++i] ?? '').replace(REGEX_SPECIALS, '\\$&')
    else if (c === '%') re += '.*'
    else if (c === '_') re += '.'
    else re += c.replace(REGEX_SPECIALS, '\\$&')
  }
  return new RegExp('^' + re + '$', 'i').test(value)
}

describe('tokensEqual', () => {
  it('is true only for identical strings', () => {
    expect(tokensEqual('abc123', 'abc123')).toBe(true)
    expect(tokensEqual('abc123', 'abc124')).toBe(false)
    expect(tokensEqual('abc123', 'abc12')).toBe(false)
    expect(tokensEqual('', '')).toBe(true)
  })

  it('never matches a missing value, even against another missing value', () => {
    expect(tokensEqual(null, null)).toBe(false)
    expect(tokensEqual(undefined, 'x')).toBe(false)
    expect(tokensEqual('x', null)).toBe(false)
  })

  it('handles multi-byte characters by bytes, not characters', () => {
    expect(tokensEqual('héllo', 'héllo')).toBe(true)
    expect(tokensEqual('héllo', 'hello')).toBe(false)
  })
})

describe('escapeLike', () => {
  it('puts a backslash before each LIKE wildcard and before the escape character itself', () => {
    expect(escapeLike('a_b%c' + BACKSLASH + 'd')).toBe(
      'a' + BACKSLASH + '_b' + BACKSLASH + '%c' + BACKSLASH + BACKSLASH + 'd',
    )
  })

  it('leaves an ordinary address alone', () => {
    expect(escapeLike('someone@example.com')).toBe('someone@example.com')
  })

  it('makes an underscore and a percent sign match literally, not as wildcards', () => {
    expect(like(escapeLike('a_b@x.com'), 'a_b@x.com')).toBe(true)
    expect(like(escapeLike('a_b@x.com'), 'axb@x.com')).toBe(false)
    expect(like(escapeLike('100%@x.com'), '100%@x.com')).toBe(true)
    expect(like(escapeLike('100%@x.com'), '1005@x.com')).toBe(false)
    // unescaped, the same input WOULD be a wildcard (what this guards against)
    expect(like('a_b@x.com', 'axb@x.com')).toBe(true)
  })

  it('stays case-insensitive under ilike', () => {
    expect(like(escapeLike('Shared.Box@Example.com'), 'shared.box@example.COM')).toBe(true)
  })
})
