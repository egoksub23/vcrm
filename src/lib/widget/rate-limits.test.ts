import { beforeEach, describe, expect, it } from 'vitest'

import { __resetRateLimitForTests, checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

beforeEach(() => __resetRateLimitForTests())

describe('widget identity rate limits', () => {
  it('a visitor gets 5 claim attempts per 10 minutes, the 6th is refused', () => {
    expect(RATE_LIMITS.widgetIdentity).toEqual({ limit: 5, windowMs: 10 * 60_000 })
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit('widget:identity:visitor-1', RATE_LIMITS.widgetIdentity).success).toBe(true)
    }
    const sixth = checkRateLimit('widget:identity:visitor-1', RATE_LIMITS.widgetIdentity)
    expect(sixth.success).toBe(false)
    expect(sixth.remaining).toBe(0)
  })

  it('visitors do not share a budget', () => {
    for (let i = 0; i < 5; i++) checkRateLimit('widget:identity:visitor-1', RATE_LIMITS.widgetIdentity)
    expect(checkRateLimit('widget:identity:visitor-2', RATE_LIMITS.widgetIdentity).success).toBe(true)
  })

  it('a script minting a new visitor per attempt still hits the token+origin bucket', () => {
    const key = 'widget:identity:o:wt_1:https://evil.example'
    for (let i = 0; i < RATE_LIMITS.widgetIdentityOrigin.limit; i++) {
      expect(checkRateLimit(key, RATE_LIMITS.widgetIdentityOrigin).success).toBe(true)
    }
    expect(checkRateLimit(key, RATE_LIMITS.widgetIdentityOrigin).success).toBe(false)
  })

  it('upload tokens: 20 per 10 minutes per visitor', () => {
    expect(RATE_LIMITS.widgetUpload).toEqual({ limit: 20, windowMs: 10 * 60_000 })
    for (let i = 0; i < 20; i++) checkRateLimit('widget:upload:v', RATE_LIMITS.widgetUpload)
    expect(checkRateLimit('widget:upload:v', RATE_LIMITS.widgetUpload).success).toBe(false)
  })

  it('enquiries: 5 per hour per visitor', () => {
    expect(RATE_LIMITS.widgetEnquiry).toEqual({ limit: 5, windowMs: 60 * 60_000 })
    for (let i = 0; i < 5; i++) checkRateLimit('widget:enquiry:v', RATE_LIMITS.widgetEnquiry)
    expect(checkRateLimit('widget:enquiry:v', RATE_LIMITS.widgetEnquiry).success).toBe(false)
  })
})
