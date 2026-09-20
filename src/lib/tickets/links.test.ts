import { describe, it, expect } from 'vitest'
import type { TicketLink } from '@/types'
import { groupLinks, invertLinkGroup, linkGroupFor, linkRowFor } from './links'

const link = (id: string, from: string, to: string, link_type: TicketLink['link_type']): TicketLink => ({
  id,
  account_id: 'a',
  from_ticket_id: from,
  to_ticket_id: to,
  link_type,
  created_at: '',
})

describe('invertLinkGroup', () => {
  it('swaps the directional types and keeps relates', () => {
    expect(invertLinkGroup('blocks')).toBe('blocked_by')
    expect(invertLinkGroup('blocked_by')).toBe('blocks')
    expect(invertLinkGroup('duplicates')).toBe('duplicated_by')
    expect(invertLinkGroup('duplicated_by')).toBe('duplicates')
    expect(invertLinkGroup('relates')).toBe('relates')
  })
  it('is its own inverse', () => {
    for (const k of ['blocks', 'blocked_by', 'relates', 'duplicates', 'duplicated_by'] as const) {
      expect(invertLinkGroup(invertLinkGroup(k))).toBe(k)
    }
  })
})

describe('linkGroupFor', () => {
  it('reads as stored from the "from" ticket and inverted from the "to" ticket', () => {
    const l = link('1', 'A', 'B', 'blocks')
    expect(linkGroupFor(l, 'A')).toBe('blocks')
    expect(linkGroupFor(l, 'B')).toBe('blocked_by')
  })
})

describe('linkRowFor', () => {
  it('stores "current is blocked by other" as other blocks current', () => {
    expect(linkRowFor('blocked_by', 'cur', 'oth')).toEqual({
      from_ticket_id: 'oth',
      to_ticket_id: 'cur',
      link_type: 'blocks',
    })
  })
  it('round-trips through linkGroupFor for every group', () => {
    for (const g of ['blocks', 'blocked_by', 'relates', 'duplicates', 'duplicated_by'] as const) {
      const row = linkRowFor(g, 'cur', 'oth')
      expect(linkGroupFor(row, 'cur')).toBe(g)
    }
  })
})

describe('groupLinks', () => {
  it('groups by point of view in a fixed order and finds the other ticket', () => {
    const links = [
      link('1', 'X', 'me', 'duplicates'),
      link('2', 'me', 'Y', 'relates'),
      link('3', 'Z', 'me', 'blocks'),
      link('4', 'me', 'W', 'blocks'),
      link('5', 'P', 'Q', 'blocks'),
    ]
    const groups = groupLinks('me', links)
    expect(groups.map((g) => g.key)).toEqual(['blocks', 'blocked_by', 'relates', 'duplicated_by'])
    expect(groups[0].items.map((i) => i.otherId)).toEqual(['W'])
    expect(groups[1].items.map((i) => i.otherId)).toEqual(['Z'])
  })
  it('is empty without links', () => {
    expect(groupLinks('me', [])).toEqual([])
  })
})
