import { describe, it, expect } from 'vitest'
import {
  previousPeriod,
  daysBetweenInclusive,
  exclusiveEnd,
  dayKeysInRange,
  percentChange,
} from './date-utils'

describe('daysBetweenInclusive', () => {
  it('counts both endpoints', () => {
    expect(daysBetweenInclusive(new Date('2026-09-15'), new Date('2026-09-17'))).toBe(3)
  })
  it('is 1 for a single-day range', () => {
    expect(daysBetweenInclusive(new Date('2026-09-15'), new Date('2026-09-15'))).toBe(1)
  })
})

describe('previousPeriod', () => {
  it('returns the immediately-preceding period of equal length', () => {
    const prev = previousPeriod({ from: new Date('2026-09-15'), to: new Date('2026-09-17') })
    expect(prev.from.toDateString()).toBe(new Date('2026-09-12').toDateString())
    expect(prev.to.toDateString()).toBe(new Date('2026-09-14').toDateString())
  })
  it('handles a single-day range', () => {
    const prev = previousPeriod({ from: new Date('2026-09-15'), to: new Date('2026-09-15') })
    expect(prev.from.toDateString()).toBe(new Date('2026-09-14').toDateString())
    expect(prev.to.toDateString()).toBe(new Date('2026-09-14').toDateString())
  })
})

describe('exclusiveEnd', () => {
  it('returns the start of the day AFTER the given date', () => {
    const end = exclusiveEnd(new Date('2026-09-17T15:30:00'))
    expect(end.toDateString()).toBe(new Date('2026-09-18').toDateString())
    expect(end.getHours()).toBe(0)
  })
})

describe('dayKeysInRange', () => {
  it('lists every local-day key inclusive, chronological', () => {
    const keys = dayKeysInRange({ from: new Date('2026-09-15'), to: new Date('2026-09-17') })
    expect(keys).toEqual(['2026-09-15', '2026-09-16', '2026-09-17'])
  })
})

describe('percentChange', () => {
  it('computes a normal percentage change', () => {
    expect(percentChange(150, 100)).toBe(50)
    expect(percentChange(50, 100)).toBe(-50)
  })
  it('returns null when the previous value is 0 and current is nonzero', () => {
    expect(percentChange(5, 0)).toBeNull()
  })
  it('returns 0 (not null) when both are 0 — genuinely flat, not undefined', () => {
    expect(percentChange(0, 0)).toBe(0)
  })
})
