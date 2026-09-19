import { describe, it, expect } from 'vitest'
import type { TicketFieldDefinition } from '@/types'
import {
  coerceValue,
  fieldsForCategory,
  fieldsForTicket,
  isEmptyValue,
  missingRequiredFields,
  parseOptions,
  sanitizeCustomValues,
} from './custom-fields'

function def(over: Partial<TicketFieldDefinition> & { id: string }): TicketFieldDefinition {
  return {
    account_id: 'a1',
    label: over.id,
    field_type: 'text',
    options: [],
    is_required: false,
    applies_to_categories: [],
    position: 0,
    is_active: true,
    created_at: '',
    updated_at: '',
    ...over,
  }
}

describe('fieldsForCategory', () => {
  const defs = [
    def({ id: 'all', position: 2 }),
    def({ id: 'billing-only', applies_to_categories: ['billing'], position: 1 }),
    def({ id: 'archived', is_active: false }),
  ]

  it('includes unscoped fields and fields scoped to the category, in position order', () => {
    expect(fieldsForCategory(defs, 'billing').map((d) => d.id)).toEqual(['billing-only', 'all'])
  })

  it('drops fields scoped to other categories and archived fields', () => {
    expect(fieldsForCategory(defs, 'bug').map((d) => d.id)).toEqual(['all'])
  })
})

describe('fieldsForTicket', () => {
  it('keeps an archived or out-of-category field visible when it holds a value', () => {
    const defs = [
      def({ id: 'archived', is_active: false }),
      def({ id: 'billing-only', applies_to_categories: ['billing'] }),
      def({ id: 'plain' }),
    ]
    const shown = fieldsForTicket(defs, 'bug', { archived: 'x', 'billing-only': 'y' })
    expect(shown.map((d) => d.id).sort()).toEqual(['archived', 'billing-only', 'plain'])
    expect(fieldsForTicket(defs, 'bug', {}).map((d) => d.id)).toEqual(['plain'])
  })
})

describe('isEmptyValue', () => {
  it('treats blank strings, unticked checkboxes and missing values as empty, but 0 as a value', () => {
    expect(isEmptyValue(undefined)).toBe(true)
    expect(isEmptyValue('  ')).toBe(true)
    expect(isEmptyValue(false)).toBe(true)
    expect(isEmptyValue(0)).toBe(false)
    expect(isEmptyValue(true)).toBe(false)
    expect(isEmptyValue('x')).toBe(false)
  })
})

describe('missingRequiredFields', () => {
  it('flags only required fields that apply to the category and are empty', () => {
    const defs = [
      def({ id: 'req', is_required: true }),
      def({ id: 'req-billing', is_required: true, applies_to_categories: ['billing'] }),
      def({ id: 'optional' }),
    ]
    expect(missingRequiredFields(defs, 'bug', {})).toEqual(['req'])
    expect(missingRequiredFields(defs, 'billing', { req: 'ok' })).toEqual(['req-billing'])
    expect(missingRequiredFields(defs, 'billing', { req: 'ok', 'req-billing': 'ok' })).toEqual([])
  })
})

describe('coerceValue / sanitizeCustomValues', () => {
  it('coerces numbers and rejects garbage', () => {
    const n = def({ id: 'n', field_type: 'number' })
    expect(coerceValue(n, '42')).toBe(42)
    expect(coerceValue(n, 0)).toBe(0)
    expect(coerceValue(n, 'abc')).toBeUndefined()
  })

  it('only accepts ISO dates and known dropdown options', () => {
    const d = def({ id: 'd', field_type: 'date' })
    const s = def({ id: 's', field_type: 'dropdown', options: ['A', 'B'] })
    expect(coerceValue(d, '2026-09-19')).toBe('2026-09-19')
    expect(coerceValue(d, '19/09/2026')).toBeUndefined()
    expect(coerceValue(s, 'A')).toBe('A')
    expect(coerceValue(s, 'C')).toBeUndefined()
  })

  it('drops blanks, unticked checkboxes, unknown ids and out-of-category values', () => {
    const defs = [
      def({ id: 't' }),
      def({ id: 'c', field_type: 'checkbox' }),
      def({ id: 'billing-only', applies_to_categories: ['billing'] }),
    ]
    expect(
      sanitizeCustomValues(defs, 'bug', {
        t: '  hello ',
        c: false,
        'billing-only': 'nope',
        ghost: 'nope',
      }),
    ).toEqual({ t: 'hello' })
  })
})

describe('parseOptions', () => {
  it('splits on commas and newlines, trims, and de-duplicates case-insensitively', () => {
    expect(parseOptions('Visa, Mastercard\n visa \n\nAmex')).toEqual(['Visa', 'Mastercard', 'Amex'])
  })
})
