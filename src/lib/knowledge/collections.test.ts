import { describe, it, expect } from 'vitest'
import { parseCollectionInput } from './collections'

describe('parseCollectionInput', () => {
  it('requires a name on create', () => {
    expect(parseCollectionInput({}, { partial: false })).toEqual({ ok: false, error: 'name is required' })
    expect(parseCollectionInput(null, { partial: false }).ok).toBe(false)
    expect(parseCollectionInput({ name: '   ' }, { partial: false })).toEqual({ ok: false, error: 'name cannot be empty' })
  })

  it('trims and tidies the name, and normalises the colour', () => {
    expect(parseCollectionInput({ name: '  Shipping   &  returns ', color: '#abcdef' }, { partial: false })).toEqual({
      ok: true,
      fields: { name: 'Shipping & returns', color: '#ABCDEF' },
    })
  })

  it('limits the name length', () => {
    expect(parseCollectionInput({ name: 'x'.repeat(61) }, { partial: false }).ok).toBe(false)
    expect(parseCollectionInput({ name: 'x'.repeat(60) }, { partial: false }).ok).toBe(true)
  })

  it.each([['red'], ['#12345'], ['#GGGGGG'], [5], ['']])('rejects colour %j', (color) => {
    expect(parseCollectionInput({ name: 'A', color }, { partial: false }).ok).toBe(false)
  })

  it('validates sort_order', () => {
    expect(parseCollectionInput({ sort_order: 3 }, { partial: true })).toEqual({ ok: true, fields: { sort_order: 3 } })
    expect(parseCollectionInput({ sort_order: 1.5 }, { partial: true }).ok).toBe(false)
    expect(parseCollectionInput({ sort_order: '3' }, { partial: true }).ok).toBe(false)
  })

  it('needs at least one field on update', () => {
    expect(parseCollectionInput({}, { partial: true })).toEqual({ ok: false, error: 'Nothing to update' })
    expect(parseCollectionInput({ color: '#000000' }, { partial: true }).ok).toBe(true)
  })
})
