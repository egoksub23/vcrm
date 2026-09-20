import { describe, it, expect } from 'vitest'
import { MAX_LABELS, MAX_LABEL_LENGTH, addLabel, normalizeLabel, removeLabel, suggestLabels } from './labels'

describe('normalizeLabel', () => {
  it('lower-cases, trims and collapses spaces', () => {
    expect(normalizeLabel('  VIP   Customer ')).toBe('vip customer')
  })
  it('turns commas into spaces so a label cannot break lists', () => {
    expect(normalizeLabel('a,b')).toBe('a b')
    expect(normalizeLabel(',')).toBe('')
  })
})

describe('addLabel', () => {
  it('adds a normalised label', () => {
    expect(addLabel(['a'], ' B ')).toEqual({ ok: true, labels: ['a', 'b'], label: 'b' })
  })
  it('refuses empty, duplicate, too long and too many', () => {
    expect(addLabel([], '  ')).toEqual({ ok: false, problem: 'empty' })
    expect(addLabel(['vip'], 'VIP')).toEqual({ ok: false, problem: 'duplicate' })
    expect(addLabel([], 'x'.repeat(MAX_LABEL_LENGTH + 1))).toEqual({ ok: false, problem: 'tooLong' })
    expect(addLabel([], 'x'.repeat(MAX_LABEL_LENGTH)).ok).toBe(true)
    const ten = Array.from({ length: MAX_LABELS }, (_, i) => `l${i}`)
    expect(addLabel(ten, 'extra')).toEqual({ ok: false, problem: 'tooMany' })
  })
  it('counts characters, not UTF-16 units', () => {
    expect(addLabel([], '가'.repeat(MAX_LABEL_LENGTH)).ok).toBe(true)
    expect(addLabel([], '😀'.repeat(MAX_LABEL_LENGTH)).ok).toBe(true)
  })
})

describe('removeLabel', () => {
  it('drops just that label', () => {
    expect(removeLabel(['a', 'b'], 'a')).toEqual(['b'])
  })
})

describe('suggestLabels', () => {
  const known = [
    { label: 'billing', uses: 5 },
    { label: 'bug', uses: 9 },
    { label: 'vip', uses: 2 },
  ]
  it('lists most used first, without what the ticket already has', () => {
    expect(suggestLabels(known, ['bug'], '')).toEqual(['billing', 'vip'])
  })
  it('filters by what was typed', () => {
    expect(suggestLabels(known, [], 'BI')).toEqual(['billing'])
  })
  it('respects the limit', () => {
    expect(suggestLabels(known, [], '', 1)).toEqual(['bug'])
  })
})
