import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async (u: string) => !u.includes('internal.test')),
}))

import { checkBaseUrlShape, validateBaseUrl } from './base-url'

describe('checkBaseUrlShape', () => {
  it('accepts an https URL and normalises the trailing slash', () => {
    expect(checkBaseUrlShape(' https://api.moonshot.ai/v1/ ')).toEqual({ ok: true, url: 'https://api.moonshot.ai/v1' })
  })

  it.each([
    ['', 'base_url_required'],
    [null, 'base_url_required'],
    ['not a url', 'base_url_invalid'],
    ['http://api.example.com/v1', 'base_url_not_https'],
    ['https://user:pw@api.example.com/v1', 'base_url_invalid'],
    ['https://api.example.com/v1?key=abc', 'base_url_invalid'],
    ['https://api.example.com/v1#frag', 'base_url_invalid'],
  ])('rejects %s', (input, code) => {
    expect(checkBaseUrlShape(input as string | null)).toEqual({ ok: false, code })
  })
})

describe('validateBaseUrl', () => {
  it('passes a public host', async () => {
    expect(await validateBaseUrl('https://api.deepseek.com/v1')).toEqual({ ok: true, url: 'https://api.deepseek.com/v1' })
  })
  it('blocks a host the SSRF guard refuses', async () => {
    expect(await validateBaseUrl('https://internal.test/v1')).toEqual({ ok: false, code: 'base_url_blocked' })
  })
  it('reports shape problems without a network check', async () => {
    expect(await validateBaseUrl('http://x.com')).toEqual({ ok: false, code: 'base_url_not_https' })
  })
})
