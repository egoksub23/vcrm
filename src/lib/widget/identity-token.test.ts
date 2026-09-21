import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  IDENTITY_TOKEN_MAX_AGE_SECONDS,
  IDENTITY_TOKEN_MAX_SKEW_SECONDS,
  generateIdentitySecret,
  normalizeEmail,
  normalizeIdentityPhone,
  signIdentityToken,
  verifyIdentityToken,
} from './identity-token'
import { IDENTITY_SNIPPETS, NODE_IDENTITY_SNIPPET } from './snippets'

const SECRET = 'wis_test_secret_value'
const NOW = 1_800_000_000

function forge(payload: unknown, secret = SECRET): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${sig}`
}

describe('signIdentityToken / verifyIdentityToken', () => {
  it('round-trips a phone, email, wallet id and name', () => {
    const token = signIdentityToken(
      SECRET,
      { phone: '60123980112', email: 'jane@example.com', walletId: 'w_1', name: 'Jane' },
      NOW,
    )
    const result = verifyIdentityToken(token, SECRET, NOW)
    expect(result).toEqual({
      ok: true,
      payload: { iat: NOW, phone: '60123980112', email: 'jane@example.com', walletId: 'w_1', name: 'Jane' },
    })
  })

  it('normalises a formatted phone to digits and lower-cases the email', () => {
    const token = forge({ phone: '+60 12-398 0112', email: 'Jane@Example.COM', iat: NOW })
    const result = verifyIdentityToken(token, SECRET, NOW)
    expect(result.ok && result.payload.phone).toBe('60123980112')
    expect(result.ok && result.payload.email).toBe('jane@example.com')
  })

  it('accepts a token with only a wallet id', () => {
    expect(verifyIdentityToken(forge({ walletId: 'w_9', iat: NOW }), SECRET, NOW).ok).toBe(true)
  })

  it('rejects a token signed with another secret', () => {
    const token = forge({ phone: '60123980112', iat: NOW }, 'some_other_secret')
    expect(verifyIdentityToken(token, SECRET, NOW)).toEqual({ ok: false, error: 'bad_identity_token' })
  })

  it('rejects a tampered payload (signature no longer matches)', () => {
    const token = signIdentityToken(SECRET, { phone: '60123980112' }, NOW)
    const [, sig] = token.split('.')
    const evil = Buffer.from(JSON.stringify({ phone: '60999999999', iat: NOW })).toString('base64url')
    expect(verifyIdentityToken(`${evil}.${sig}`, SECRET, NOW)).toEqual({ ok: false, error: 'bad_identity_token' })
  })

  it('rejects a tampered signature', () => {
    const token = signIdentityToken(SECRET, { phone: '60123980112' }, NOW)
    const [body, sig] = token.split('.')
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)
    expect(verifyIdentityToken(`${body}.${flipped}`, SECRET, NOW)).toEqual({ ok: false, error: 'bad_identity_token' })
  })

  it('rejects a truncated signature and an empty one', () => {
    const token = signIdentityToken(SECRET, { phone: '60123980112' }, NOW)
    const [body, sig] = token.split('.')
    expect(verifyIdentityToken(`${body}.${sig.slice(0, 10)}`, SECRET, NOW).ok).toBe(false)
    expect(verifyIdentityToken(`${body}.`, SECRET, NOW).ok).toBe(false)
  })

  it.each([
    ['not a string', 42],
    ['empty', ''],
    ['no dot', 'abcdef'],
    ['too many parts', 'a.b.c'],
    ['garbage', '!!!.???'],
  ])('rejects a malformed token (%s)', (_label, token) => {
    expect(verifyIdentityToken(token, SECRET, NOW)).toEqual({ ok: false, error: 'bad_identity_token' })
  })

  it('rejects when no secret is configured', () => {
    const token = signIdentityToken(SECRET, { phone: '60123980112' }, NOW)
    expect(verifyIdentityToken(token, '', NOW).ok).toBe(false)
  })

  it('rejects a validly signed token that identifies nobody', () => {
    expect(verifyIdentityToken(forge({ name: 'Nobody', iat: NOW }), SECRET, NOW)).toEqual({
      ok: false,
      error: 'bad_identity_token',
    })
  })

  it('rejects a validly signed token with an invalid phone or email', () => {
    expect(verifyIdentityToken(forge({ phone: '12', iat: NOW }), SECRET, NOW).ok).toBe(false)
    expect(verifyIdentityToken(forge({ email: 'not-an-email', iat: NOW }), SECRET, NOW).ok).toBe(false)
  })

  it('rejects a validly signed token without a numeric iat', () => {
    expect(verifyIdentityToken(forge({ phone: '60123980112' }), SECRET, NOW).ok).toBe(false)
    expect(verifyIdentityToken(forge({ phone: '60123980112', iat: 'now' }), SECRET, NOW).ok).toBe(false)
  })

  describe('expiry window (age = now - iat)', () => {
    const at = (age: number) => verifyIdentityToken(signIdentityToken(SECRET, { phone: '60123980112' }, NOW - age), SECRET, NOW)

    it('accepts a fresh token', () => {
      expect(at(0).ok).toBe(true)
    })
    it('accepts up to 10 minutes old, inclusive', () => {
      expect(at(IDENTITY_TOKEN_MAX_AGE_SECONDS).ok).toBe(true)
    })
    it('rejects older than 10 minutes as expired', () => {
      expect(at(IDENTITY_TOKEN_MAX_AGE_SECONDS + 1)).toEqual({ ok: false, error: 'expired_identity_token' })
    })
    it('accepts a token stamped up to 60 seconds in the future (clock skew)', () => {
      expect(at(-IDENTITY_TOKEN_MAX_SKEW_SECONDS).ok).toBe(true)
    })
    it('rejects a token stamped further in the future as expired', () => {
      expect(at(-(IDENTITY_TOKEN_MAX_SKEW_SECONDS + 1))).toEqual({ ok: false, error: 'expired_identity_token' })
    })
    it('never reports "expired" for a wrong secret (signature is checked first)', () => {
      const token = forge({ phone: '60123980112', iat: NOW - 10_000 }, 'other')
      expect(verifyIdentityToken(token, SECRET, NOW)).toEqual({ ok: false, error: 'bad_identity_token' })
    })
  })
})

describe('generateIdentitySecret', () => {
  it('makes a prefixed, high-entropy, unique secret', () => {
    const a = generateIdentitySecret()
    const b = generateIdentitySecret()
    expect(a).toMatch(/^wis_[A-Za-z0-9_-]{43}$/)
    expect(a).not.toBe(b)
  })
})

describe('normalisers', () => {
  it('normalizeEmail', () => {
    expect(normalizeEmail('  A@B.co ')).toBe('a@b.co')
    expect(normalizeEmail('nope')).toBeNull()
    expect(normalizeEmail('a b@c.d')).toBeNull()
    expect(normalizeEmail(5)).toBeNull()
  })
  it('normalizeIdentityPhone', () => {
    expect(normalizeIdentityPhone('+60 12 398 0112')).toBe('60123980112')
    expect(normalizeIdentityPhone('123')).toBeNull()
    expect(normalizeIdentityPhone(undefined)).toBeNull()
  })
})

describe('the documented snippets', () => {
  it('the Node snippet produces tokens the verifier accepts', () => {
    // Strip the ES import + export so the body can run inside the test.
    const body = NODE_IDENTITY_SNIPPET.replace("import crypto from 'node:crypto'", '')
      .replace('export function', 'function')
      .replace('process.env.VIRCLE_WIDGET_SECRET', JSON.stringify(SECRET))
    const make = new Function('crypto', 'Buffer', `${body}; return widgetIdentityToken;`)(
      { createHmac },
      Buffer,
    ) as (u: Record<string, string | undefined>) => string

    const token = make({ phone: '+60123980112', email: 'jane@example.com', name: 'Jane' })
    const result = verifyIdentityToken(token, SECRET)
    expect(result.ok).toBe(true)
    expect(result.ok && result.payload.phone).toBe('60123980112')
    expect(result.ok && result.payload.email).toBe('jane@example.com')
  })

  it('ships a snippet for Node, PHP and Python that names the same fields', () => {
    for (const code of Object.values(IDENTITY_SNIPPETS)) {
      expect(code).toMatch(/phone/)
      expect(code).toMatch(/walletId/)
      expect(code).toMatch(/iat/)
      expect(code).toMatch(/VIRCLE_WIDGET_SECRET/)
      expect(code).toMatch(/sha256/i)
    }
  })
})
