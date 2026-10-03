import { describe, expect, it } from 'vitest'

import { diagnosticRows, isGrantActive, isSupportSection, SUPPORT_SECTIONS } from './support'

describe('isSupportSection', () => {
  it('accepts exactly the sections the database answers', () => {
    for (const s of SUPPORT_SECTIONS) expect(isSupportSection(s)).toBe(true)
    expect(isSupportSection('messages')).toBe(false)
    expect(isSupportSection(undefined)).toBe(false)
    expect(isSupportSection('')).toBe(false)
  })
})

describe('isGrantActive', () => {
  const now = new Date('2026-10-04T12:00:00Z')
  it('is active until it expires or is revoked', () => {
    expect(isGrantActive({ expires_at: '2026-10-04T13:00:00Z', revoked_at: null }, now)).toBe(true)
    expect(isGrantActive({ expires_at: '2026-10-04T11:59:59Z', revoked_at: null }, now)).toBe(false)
    expect(isGrantActive({ expires_at: '2026-10-04T13:00:00Z', revoked_at: '2026-10-04T11:00:00Z' }, now)).toBe(false)
  })
})

describe('diagnosticRows', () => {
  it('flattens objects to dotted paths and lists to indexes', () => {
    expect(diagnosticRows({ plan: 'standard', limits: { seats: 5 }, failures: [{ channel: 'whatsapp', count: 2 }] })).toEqual([
      { path: 'plan', value: 'standard' },
      { path: 'limits.seats', value: '5' },
      { path: 'failures[0].channel', value: 'whatsapp' },
      { path: 'failures[0].count', value: '2' },
    ])
  })

  it('shows empty lists and objects as none, and null as a dash', () => {
    expect(diagnosticRows({ failures: [], jobs: {}, suspended_reason: null })).toEqual([
      { path: 'failures', value: 'none' },
      { path: 'jobs', value: 'none' },
      { path: 'suspended_reason', value: '—' },
    ])
  })
})
