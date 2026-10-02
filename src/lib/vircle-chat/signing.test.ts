import { describe, expect, it } from 'vitest'

import { SIGNATURE_TOLERANCE_SECONDS, signBody, verifySignature } from './signing'

const secret = 'whsec_test'
const body = '{"event":"message.inbound","event_id":"evt_1"}'
const now = 1_790_000_000

function check(overrides: Partial<Parameters<typeof verifySignature>[0]> = {}) {
  return verifySignature({
    secret,
    timestampHeader: String(now),
    signatureHeader: signBody(secret, now, body),
    rawBody: body,
    nowSeconds: now,
    ...overrides,
  })
}

describe('signBody', () => {
  it('is sha256= plus a 64-character hex digest, stable for the same input', () => {
    const sig = signBody(secret, now, body)
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(signBody(secret, now, body)).toBe(sig)
  })

  it('matches the contract: HMAC-SHA256 over "<timestamp>.<raw body>"', async () => {
    const { createHmac } = await import('node:crypto')
    const expected = createHmac('sha256', secret).update(`${now}.${body}`).digest('hex')
    expect(signBody(secret, now, body)).toBe(`sha256=${expected}`)
  })
})

describe('verifySignature', () => {
  it('accepts a correctly signed, fresh request', () => {
    expect(check()).toBe('ok')
  })

  it('rejects a changed body, a wrong secret and a changed timestamp', () => {
    expect(check({ rawBody: body.replace('evt_1', 'evt_2') })).toBe('bad_signature')
    expect(check({ secret: 'other' })).toBe('bad_signature')
    // Same signature presented with a newer timestamp: the timestamp is part of what was signed.
    expect(check({ timestampHeader: String(now + 1) })).toBe('bad_signature')
  })

  it('rejects a request outside the five-minute window, either side', () => {
    const old = now - SIGNATURE_TOLERANCE_SECONDS - 1
    expect(check({ timestampHeader: String(old), signatureHeader: signBody(secret, old, body) })).toBe('stale')
    const future = now + SIGNATURE_TOLERANCE_SECONDS + 1
    expect(check({ timestampHeader: String(future), signatureHeader: signBody(secret, future, body) })).toBe('stale')
    const edge = now - SIGNATURE_TOLERANCE_SECONDS
    expect(check({ timestampHeader: String(edge), signatureHeader: signBody(secret, edge, body) })).toBe('ok')
  })

  it('rejects missing or malformed headers without comparing anything', () => {
    expect(check({ timestampHeader: null })).toBe('missing')
    expect(check({ signatureHeader: null })).toBe('missing')
    expect(check({ timestampHeader: 'yesterday' })).toBe('bad_timestamp')
    expect(check({ timestampHeader: '-5' })).toBe('bad_timestamp')
  })

  it('rejects a signature of the wrong length or without the prefix', () => {
    expect(check({ signatureHeader: 'sha256=abc' })).toBe('bad_signature')
    expect(check({ signatureHeader: signBody(secret, now, body).replace('sha256=', '') })).toBe('bad_signature')
  })
})
