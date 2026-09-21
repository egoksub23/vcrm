import { describe, expect, it } from 'vitest'

import { claimMatchesContact, meaningfulName, parseSessionBody } from './session-request'

const ok = (body: unknown) => {
  const r = parseSessionBody(body)
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`)
  return r.value
}

describe('parseSessionBody', () => {
  it('requires a widgetToken', () => {
    expect(parseSessionBody({})).toMatchObject({ ok: false, status: 400 })
    expect(parseSessionBody(null)).toMatchObject({ ok: false, status: 400 })
  })

  it('parses a plain first call (nothing offered)', () => {
    const v = ok({ widgetToken: 'wt_1' })
    expect(v).toMatchObject({ widgetToken: 'wt_1', identityToken: null, claim: null, skipIdentity: false, locale: 'en' })
  })

  it('reads identityToken, skipIdentity and locale', () => {
    const v = ok({ widgetToken: 'wt_1', identityToken: ' abc.def ', skipIdentity: true, locale: 'zh' })
    expect(v).toMatchObject({ identityToken: 'abc.def', skipIdentity: true, locale: 'zh' })
  })

  it('falls back to en for an unknown locale', () => {
    expect(ok({ widgetToken: 'wt_1', locale: 'fr' }).locale).toBe('en')
  })

  it('normalises a typed claim (digits phone, lower-case email) and takes the name', () => {
    const v = ok({ widgetToken: 't', claim: { phone: '+60 12-398 0112', email: 'Jane@Example.com', name: ' Jane ' } })
    expect(v.claim).toEqual({ phone: '60123980112', email: 'jane@example.com', name: 'Jane', legacy: false })
  })

  it('accepts a claim with only an email', () => {
    expect(ok({ widgetToken: 't', claim: { email: 'a@b.co' } }).claim).toMatchObject({ phone: null, email: 'a@b.co' })
  })

  it('rejects an empty or name-only claim as invalid_claim', () => {
    expect(parseSessionBody({ widgetToken: 't', claim: {} })).toMatchObject({ ok: false, code: 'invalid_claim' })
    expect(parseSessionBody({ widgetToken: 't', claim: { name: 'Jane' } })).toMatchObject({
      ok: false,
      code: 'invalid_claim',
    })
  })

  it('rejects a bad claim phone or email as invalid_claim', () => {
    expect(parseSessionBody({ widgetToken: 't', claim: { phone: '12' } })).toMatchObject({ ok: false, status: 400, code: 'invalid_claim' })
    expect(parseSessionBody({ widgetToken: 't', claim: { email: 'nope' } })).toMatchObject({ ok: false, status: 400, code: 'invalid_claim' })
    expect(parseSessionBody({ widgetToken: 't', claim: 'x' })).toMatchObject({ ok: false, code: 'invalid_claim' })
  })

  describe('legacy fields', () => {
    it('visitorPhone is a typed claim', () => {
      expect(ok({ widgetToken: 't', visitorPhone: '+60123980112' }).claim).toMatchObject({
        phone: '60123980112',
        legacy: false,
      })
    })

    it('a bad visitorPhone is still a 400 (unchanged contract)', () => {
      expect(parseSessionBody({ widgetToken: 't', visitorPhone: 'abc' })).toMatchObject({
        ok: false,
        status: 400,
        code: 'invalid_claim',
      })
    })

    it('verifiedIdentity becomes an UNVERIFIED claim (never trusted any more)', () => {
      const v = ok({ widgetToken: 't', verifiedIdentity: { phone: '60123980112', email: 'a@b.co', walletId: 'w1' } })
      expect(v.claim).toEqual({ phone: '60123980112', email: 'a@b.co', name: null, legacy: true })
      expect(v.identityToken).toBeNull()
    })

    it('a malformed verifiedIdentity is ignored silently (host bug), not a 400', () => {
      const v = ok({ widgetToken: 't', verifiedIdentity: { phone: 'nope', email: 'nope' } })
      expect(v.claim).toBeNull()
    })

    it('an explicit claim wins over the legacy fields', () => {
      const v = ok({ widgetToken: 't', claim: { phone: '60111222333' }, visitorPhone: '60999888777' })
      expect(v.claim?.phone).toBe('60111222333')
    })

    it('visitorName fills a missing claim name', () => {
      expect(ok({ widgetToken: 't', visitorName: 'Sam', visitorPhone: '60123980112' }).claim?.name).toBe('Sam')
    })
  })
})

describe('claimMatchesContact', () => {
  const contact = { phone: '60123980112', email: 'Jane@Example.com' }
  it('matches the same phone tolerant of a trunk prefix', () => {
    expect(claimMatchesContact(contact, { phone: '600123980112', email: null })).toBe(true)
  })
  it('matches the same email case-insensitively', () => {
    expect(claimMatchesContact(contact, { phone: null, email: 'jane@example.com' })).toBe(true)
  })
  it('does not match a different phone or email', () => {
    expect(claimMatchesContact(contact, { phone: '60111000111', email: null })).toBe(false)
    expect(claimMatchesContact(contact, { phone: null, email: 'other@example.com' })).toBe(false)
  })
  it('a contact with no phone never matches a phone claim', () => {
    expect(claimMatchesContact({ phone: '', email: null }, { phone: '60123980112', email: null })).toBe(false)
  })
})

describe('meaningfulName', () => {
  it('hides the placeholder and blanks', () => {
    expect(meaningfulName('Website visitor')).toBeNull()
    expect(meaningfulName('  ')).toBeNull()
    expect(meaningfulName(null)).toBeNull()
    expect(meaningfulName(' Jane ')).toBe('Jane')
  })
})
