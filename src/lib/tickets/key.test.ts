import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TICKET_PREFIX,
  isValidPrefix,
  normalizePrefix,
  parseTicketQuery,
  ticketKey,
  ticketMatchesSearch,
} from './key'

describe('ticketKey', () => {
  it('joins prefix and number', () => {
    expect(ticketKey('ACME', 7)).toBe('ACME-7')
  })
  it('falls back to VIR until the account prefix is loaded', () => {
    expect(ticketKey(undefined, 12)).toBe('VIR-12')
    expect(ticketKey('', 12)).toBe('VIR-12')
    expect(DEFAULT_TICKET_PREFIX).toBe('VIR')
  })
})

describe('prefix rules (mirror the DB CHECK)', () => {
  it('accepts 2-6 upper-case letters or digits starting with a letter', () => {
    for (const p of ['VIR', 'AB', 'ABCDEF', 'A1', 'ACME2']) expect(isValidPrefix(p)).toBe(true)
  })
  it('rejects everything else', () => {
    for (const p of ['', 'A', 'ABCDEFG', 'vir', '1AB', 'AB-C', 'AB C']) expect(isValidPrefix(p)).toBe(false)
  })
  it('normalises what an admin typed', () => {
    expect(normalizePrefix('  acme ')).toBe('ACME')
  })
})

describe('parseTicketQuery', () => {
  it('reads a full key', () => {
    expect(parseTicketQuery('VIR-12')).toMatchObject({ number: 12, prefix: 'VIR' })
    expect(parseTicketQuery('vir-12')).toMatchObject({ number: 12, prefix: 'VIR' })
  })
  it('reads a bare or hashed number', () => {
    expect(parseTicketQuery('12')).toMatchObject({ number: 12, prefix: null, text: '12' })
    expect(parseTicketQuery('#12')).toMatchObject({ number: 12, prefix: null, text: '12' })
  })
  it('treats words as text', () => {
    expect(parseTicketQuery('  Refund  ')).toEqual({ number: null, prefix: null, text: 'refund' })
  })
})

describe('ticketMatchesSearch', () => {
  const t = { ticket_number: 12, subject: 'Refund not received', description: 'Order 4711 is missing' }
  it('matches by key, number and text', () => {
    expect(ticketMatchesSearch(t, 'VIR-12', 'VIR')).toBe(true)
    expect(ticketMatchesSearch(t, '12', 'VIR')).toBe(true)
    expect(ticketMatchesSearch(t, '#12', 'VIR')).toBe(true)
    expect(ticketMatchesSearch(t, 'refund', 'VIR')).toBe(true)
    expect(ticketMatchesSearch(t, '4711', 'VIR')).toBe(true)
  })
  it('does not match another ticket number or another prefix', () => {
    expect(ticketMatchesSearch(t, 'VIR-13', 'VIR')).toBe(false)
    expect(ticketMatchesSearch(t, 'ACME-12', 'VIR')).toBe(false)
    expect(ticketMatchesSearch(t, 'shipping', 'VIR')).toBe(false)
  })
  it('follows the account prefix', () => {
    expect(ticketMatchesSearch(t, 'ACME-12', 'ACME')).toBe(true)
    expect(ticketMatchesSearch(t, 'VIR-12', 'ACME')).toBe(false)
  })
  it('an empty query matches everything', () => {
    expect(ticketMatchesSearch(t, '   ', 'VIR')).toBe(true)
  })
})
