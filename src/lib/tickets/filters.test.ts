import { describe, it, expect } from 'vitest'
import type { Ticket } from '@/types'
import {
  UNASSIGNED,
  applyFilters,
  countActiveFilters,
  emptyFilters,
  filtersFromJson,
  filtersToJson,
  hasActiveFilters,
  parseFilters,
  serializeFilters,
} from './filters'

const params = (s: string) => new URLSearchParams(s)

describe('parseFilters / serializeFilters', () => {
  it('round-trips through the URL', () => {
    const f = {
      q: 'refund',
      quick: ['mine', 'overdue'] as const,
      assignees: ['u1', UNASSIGNED],
      types: ['bug', 'billing'] as const,
      priorities: ['urgent'] as const,
      labels: ['vip', 'two words'],
      teams: ['t1'],
      statuses: ['open', 'in_progress'] as const,
    }
    const url = serializeFilters({ ...f, quick: [...f.quick], types: [...f.types], priorities: [...f.priorities], statuses: [...f.statuses] })
    const back = parseFilters(url)
    expect(back).toEqual({ ...f, quick: [...f.quick], types: [...f.types], priorities: [...f.priorities], statuses: [...f.statuses] })
  })
  it('is empty for an empty query', () => {
    expect(parseFilters(params(''))).toEqual(emptyFilters())
    expect(serializeFilters(emptyFilters()).toString()).toBe('')
  })
  it('keeps unrelated parameters and replaces the filter ones', () => {
    const base = params('t=abc&sort=due:asc&status=closed&q=old')
    const out = serializeFilters({ ...emptyFilters(), q: 'new' }, base)
    expect(out.get('t')).toBe('abc')
    expect(out.get('sort')).toBe('due:asc')
    expect(out.get('q')).toBe('new')
    expect(out.has('status')).toBe(false)
  })
  it('drops values it does not know, so a hand-edited link is harmless', () => {
    const f = parseFilters(params('type=bug,nonsense&priority=asap&status=open,waiting&quick=mine,zzz'))
    expect(f.types).toEqual(['bug'])
    expect(f.priorities).toEqual([])
    expect(f.statuses).toEqual(['open'])
    expect(f.quick).toEqual(['mine'])
  })
  it('normalises labels and removes duplicates', () => {
    expect(parseFilters(params('label=VIP,vip,%20Bug%20')).labels).toEqual(['vip', 'bug'])
  })
})

describe('saved filter JSON', () => {
  it('stores and restores the same filters', () => {
    const f = { ...emptyFilters(), q: 'x', quick: ['today' as const], teams: ['t9'] }
    expect(filtersFromJson(filtersToJson(f))).toEqual(f)
  })
  it('ignores junk', () => {
    expect(filtersFromJson(null)).toEqual(emptyFilters())
    expect(filtersFromJson({ q: 5, sort: 'due:asc', type: 'bug' })).toEqual({ ...emptyFilters(), types: ['bug'] })
  })
})

describe('hasActiveFilters / countActiveFilters', () => {
  it('reports nothing for empty filters', () => {
    expect(hasActiveFilters(emptyFilters())).toBe(false)
    expect(countActiveFilters(emptyFilters())).toBe(0)
  })
  it('ignores the status filter where it does not apply (board)', () => {
    const f = { ...emptyFilters(), statuses: ['open' as const] }
    expect(hasActiveFilters(f, true)).toBe(true)
    expect(hasActiveFilters(f, false)).toBe(false)
    expect(countActiveFilters(f, false)).toBe(0)
  })
  it('counts each dropdown once and each chip', () => {
    expect(
      countActiveFilters({ ...emptyFilters(), q: 'a', quick: ['mine', 'today'], assignees: ['u1', 'u2'] }),
    ).toBe(4)
  })
})

describe('applyFilters', () => {
  const now = new Date(2026, 8, 20, 12)
  const base = {
    ticket_number: 1,
    subject: 'Something',
    description: null,
    status: 'open',
    priority: 'normal',
    category: 'general',
    assigned_agent_id: null,
    assigned_team_id: null,
    labels: [],
    due_date: null,
    updated_at: new Date(2026, 8, 20, 9).toISOString(),
  } as const
  const t = (over: Partial<Ticket>) => ({ ...base, ...over }) as Pick<Ticket, keyof typeof base>
  const ctx = { userId: 'me', prefix: 'VIR', now }

  const rows = [
    t({ ticket_number: 1, subject: 'Refund', assigned_agent_id: 'me', priority: 'urgent', category: 'billing', labels: ['vip'] }),
    t({ ticket_number: 2, subject: 'Login bug', assigned_agent_id: 'other', category: 'bug', due_date: '2026-09-10' }),
    t({ ticket_number: 3, subject: 'Old thing', updated_at: new Date(2026, 8, 1).toISOString(), assigned_team_id: 'sales' }),
    t({ ticket_number: 4, subject: 'Done late', status: 'resolved', due_date: '2026-09-01' }),
  ]
  const nums = (f: Partial<ReturnType<typeof emptyFilters>>) =>
    applyFilters(rows, { ...emptyFilters(), ...f }, ctx).map((r) => r.ticket_number)

  it('no filters keeps everything', () => {
    expect(nums({})).toEqual([1, 2, 3, 4])
  })
  it('search by key, number and words', () => {
    expect(nums({ q: 'VIR-2' })).toEqual([2])
    expect(nums({ q: '#3' })).toEqual([3])
    expect(nums({ q: 'refund' })).toEqual([1])
  })
  it('quick chips: mine, unassigned, overdue (not for finished tickets), updated today', () => {
    expect(nums({ quick: ['mine'] })).toEqual([1])
    expect(nums({ quick: ['unassigned'] })).toEqual([3, 4])
    expect(nums({ quick: ['overdue'] })).toEqual([2])
    expect(nums({ quick: ['today'] })).toEqual([1, 2, 4])
  })
  it('chips combine with AND', () => {
    expect(nums({ quick: ['unassigned', 'today'] })).toEqual([4])
  })
  it('assignee filter is multi-select and understands unassigned', () => {
    expect(nums({ assignees: ['other', UNASSIGNED] })).toEqual([2, 3, 4])
  })
  it('type, priority, label, team, status', () => {
    expect(nums({ types: ['bug'] })).toEqual([2])
    expect(nums({ priorities: ['urgent'] })).toEqual([1])
    expect(nums({ labels: ['vip', 'x'] })).toEqual([1])
    expect(nums({ teams: ['sales'] })).toEqual([3])
    expect(nums({ statuses: ['resolved'] })).toEqual([4])
  })
  it('the board ignores the status filter', () => {
    const f = { ...emptyFilters(), statuses: ['resolved' as const] }
    expect(applyFilters(rows, f, ctx, false)).toHaveLength(4)
  })
  it('"my tickets" matches nothing without a signed-in user', () => {
    expect(applyFilters(rows, { ...emptyFilters(), quick: ['mine'] }, { ...ctx, userId: null })).toEqual([])
  })
})
