import { describe, expect, it } from 'vitest'

import { clientIp, trustedProxyHops } from './client-ip'

const h = (init: Record<string, string>) => new Headers(init)

describe('clientIp', () => {
  it('with one trusted proxy, uses the entry the proxy appended, not what the client sent', () => {
    // client claims 6.6.6.6; the proxy saw 203.0.113.9 and appended it
    expect(clientIp(h({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }), 1)).toBe('203.0.113.9')
  })

  it('a client cannot change its bucket by varying the leftmost entries', () => {
    const a = clientIp(h({ 'x-forwarded-for': '1.1.1.1, 203.0.113.9' }), 1)
    const b = clientIp(h({ 'x-forwarded-for': '2.2.2.2, 3.3.3.3, 203.0.113.9' }), 1)
    expect(a).toBe(b)
  })

  it('counts hops from the right when two proxies are trusted', () => {
    expect(clientIp(h({ 'x-forwarded-for': '9.9.9.9, 203.0.113.9, 172.16.0.4' }), 2)).toBe('203.0.113.9')
  })

  it('uses the only entry when there are fewer entries than hops', () => {
    expect(clientIp(h({ 'x-forwarded-for': '203.0.113.9' }), 2)).toBe('203.0.113.9')
  })

  it('falls back to x-real-ip, then to a constant', () => {
    expect(clientIp(h({ 'x-real-ip': '198.51.100.7' }), 1)).toBe('198.51.100.7')
    expect(clientIp(h({}), 1)).toBe('unknown')
  })

  it('believes no header at all with zero trusted proxies', () => {
    expect(clientIp(h({ 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '198.51.100.7' }), 0)).toBe('unknown')
  })
})

describe('trustedProxyHops', () => {
  it('defaults to one and ignores nonsense', () => {
    expect(trustedProxyHops({})).toBe(1)
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '' })).toBe(1)
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: 'abc' })).toBe(1)
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '-1' })).toBe(1)
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '99' })).toBe(1)
  })

  it('reads a valid count, including zero', () => {
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '0' })).toBe(0)
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '2' })).toBe(2)
  })
})
