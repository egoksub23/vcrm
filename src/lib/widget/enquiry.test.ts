import { describe, expect, it } from 'vitest'

import { ENQUIRY_MESSAGE_MAX, ENQUIRY_NAME_MAX, enquiryMessageText, parseEnquiryBody, parseLocale } from './enquiry'

const valid = (over: Record<string, unknown> = {}) => ({
  widgetToken: 'wt_1',
  name: 'Aisyah',
  phone: '+60 12-398 0112',
  role: 'parent',
  message: 'How do I enrol my child?',
  consent: true,
  ...over,
})

describe('parseEnquiryBody', () => {
  it('accepts a phone-only enquiry and normalises it', () => {
    const r = parseEnquiryBody(valid())
    expect(r).toEqual({
      ok: true,
      value: {
        name: 'Aisyah',
        phone: '60123980112',
        email: null,
        role: 'parent',
        message: 'How do I enrol my child?',
        locale: 'en',
      },
    })
  })

  it('accepts an email-only enquiry, lower-cased', () => {
    const r = parseEnquiryBody(valid({ phone: undefined, email: 'Aisyah@Example.com' }))
    expect(r.ok && r.value).toMatchObject({ phone: null, email: 'aisyah@example.com' })
  })

  it('accepts both phone and email, and a locale', () => {
    const r = parseEnquiryBody(valid({ email: 'a@b.co', locale: 'ms' }))
    expect(r.ok && r.value).toMatchObject({ phone: '60123980112', email: 'a@b.co', locale: 'ms' })
  })

  it('requires phone OR email', () => {
    expect(parseEnquiryBody(valid({ phone: undefined }))).toMatchObject({ ok: false, code: 'invalid_claim' })
    expect(parseEnquiryBody(valid({ phone: '  ', email: '' }))).toMatchObject({ ok: false, code: 'invalid_claim' })
  })

  it('rejects an invalid phone or email', () => {
    expect(parseEnquiryBody(valid({ phone: '12' }))).toMatchObject({ ok: false, code: 'invalid_claim' })
    expect(parseEnquiryBody(valid({ phone: undefined, email: 'nope' }))).toMatchObject({ ok: false, code: 'invalid_claim' })
  })

  it('requires consent to be exactly true', () => {
    for (const consent of [false, undefined, 'true', 1, null]) {
      expect(parseEnquiryBody(valid({ consent }))).toMatchObject({ ok: false, code: 'bad_request' })
    }
  })

  it('validates the role', () => {
    for (const role of ['student', '', undefined, 5]) {
      expect(parseEnquiryBody(valid({ role })).ok).toBe(false)
    }
    for (const role of ['parent', 'school', 'merchant', 'other']) {
      expect(parseEnquiryBody(valid({ role })).ok).toBe(true)
    }
  })

  it('bounds the name (1..120) and the message (1..2000)', () => {
    expect(parseEnquiryBody(valid({ name: '' })).ok).toBe(false)
    expect(parseEnquiryBody(valid({ name: 'x'.repeat(ENQUIRY_NAME_MAX) })).ok).toBe(true)
    expect(parseEnquiryBody(valid({ name: 'x'.repeat(ENQUIRY_NAME_MAX + 1) })).ok).toBe(false)
    expect(parseEnquiryBody(valid({ message: '   ' })).ok).toBe(false)
    expect(parseEnquiryBody(valid({ message: 'x'.repeat(ENQUIRY_MESSAGE_MAX) })).ok).toBe(true)
    expect(parseEnquiryBody(valid({ message: 'x'.repeat(ENQUIRY_MESSAGE_MAX + 1) })).ok).toBe(false)
  })

  it('rejects a non-object body', () => {
    expect(parseEnquiryBody(null).ok).toBe(false)
    expect(parseEnquiryBody('x').ok).toBe(false)
  })
})

describe('enquiryMessageText / parseLocale', () => {
  it('puts a short header above the text', () => {
    expect(enquiryMessageText('merchant', 'Hello')).toBe('[Web enquiry - Merchant]\nHello')
  })
  it('parseLocale falls back to en', () => {
    expect(parseLocale('zh')).toBe('zh')
    expect(parseLocale('de')).toBe('en')
    expect(parseLocale(undefined)).toBe('en')
  })
})
