import { describe, it, expect } from 'vitest'
import { dueState, endOfDueDay, toDateInputValue } from './due'

// Local-time dates, so these hold in any time zone.
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min)

describe('dueState', () => {
  const now = at(2026, 9, 20, 10)
  it('has no state without a date', () => {
    expect(dueState(null, now)).toBe('none')
    expect(dueState(undefined, now)).toBe('none')
    expect(dueState('not-a-date', now)).toBe('none')
  })
  it('is overdue once the due day is over', () => {
    expect(dueState('2026-09-19', now)).toBe('overdue')
    expect(dueState('2026-09-20', at(2026, 9, 21, 0, 1))).toBe('overdue')
  })
  it('is soon on the due day (less than 24h left)', () => {
    expect(dueState('2026-09-20', now)).toBe('soon')
    expect(dueState('2026-09-20', at(2026, 9, 20, 23, 30))).toBe('soon')
  })
  it('is later from tomorrow on', () => {
    expect(dueState('2026-09-21', now)).toBe('later')
    expect(dueState('2026-12-01', now)).toBe('later')
  })
  it('a finished ticket is never overdue or soon', () => {
    expect(dueState('2026-09-01', now, true)).toBe('done')
    expect(dueState(null, now, true)).toBe('none')
  })
})

describe('endOfDueDay', () => {
  it('is 23:59:59 local', () => {
    const end = endOfDueDay('2026-09-20')!
    expect([end.getFullYear(), end.getMonth(), end.getDate(), end.getHours()]).toEqual([2026, 8, 20, 23])
  })
  it('rejects impossible dates', () => {
    expect(endOfDueDay('2026-02-31')).toBeNull()
    expect(endOfDueDay('nope')).toBeNull()
  })
})

describe('toDateInputValue', () => {
  it('formats a local date', () => {
    expect(toDateInputValue(at(2026, 1, 5))).toBe('2026-01-05')
  })
})
