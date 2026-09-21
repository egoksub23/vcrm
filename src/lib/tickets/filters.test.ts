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

describe('SLA quick chips (migration 086)', () => {
  const NOW = new Date('2026-09-20T12:00:00Z')
  const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString()
  const ticket = (n: number, over: Partial<Ticket>) =>
    ({
      ticket_number: n,
      subject: `S${n}`,
      description: null,
      status: 'open',
      priority: 'normal',
      category: 'general',
      assigned_agent_id: null,
      assigned_team_id: null,
      labels: [],
      due_date: null,
      updated_at: '2026-09-01T00:00:00Z',
      ...over,
    }) as Pick<
      Ticket,
      | 'ticket_number' | 'subject' | 'description' | 'status' | 'priority' | 'category' | 'assigned_agent_id'
      | 'assigned_team_id' | 'labels' | 'due_date' | 'updated_at' | 'sla_first_response_state'
      | 'sla_first_response_due_at' | 'sla_first_response_risk_at' | 'sla_resolution_state'
      | 'sla_resolution_due_at' | 'sla_resolution_risk_at'
    >
  const running = (due: number, risk: number): Partial<Ticket> => ({
    sla_first_response_state: 'running',
    sla_first_response_due_at: at(due),
    sla_first_response_risk_at: at(risk),
  })
  const sla = [
    ticket(1, running(120, 90)), // on track
    ticket(2, running(30, -5)), // at risk
    ticket(3, running(-10, -50)), // breached (past due, the sweep has not marked it yet)
    ticket(4, { sla_first_response_state: 'breached', sla_first_response_due_at: at(-500), sla_first_response_risk_at: at(-600), status: 'resolved' }),
    ticket(5, {}), // no SLA
  ]
  const ctx = { userId: 'me', prefix: 'VIR', now: NOW }
  const nums = (quick: ('sla_at_risk' | 'sla_breached')[]) =>
    applyFilters(sla, { ...emptyFilters(), quick }, ctx).map((t) => t.ticket_number)

  it('SLA at risk shows tickets with a target close to its limit', () => {
    expect(nums(['sla_at_risk'])).toEqual([2])
  })
  it('SLA breached shows past-due tickets without waiting for the sweep, and finished ones that missed', () => {
    expect(nums(['sla_breached'])).toEqual([3, 4])
  })
  it('both chips together must both match, so nothing here', () => {
    expect(nums(['sla_at_risk', 'sla_breached'])).toEqual([])
  })
  it('the chips round-trip through the URL and a saved filter', () => {
    const f = { ...emptyFilters(), quick: ['sla_at_risk' as const, 'sla_breached' as const] }
    const url = serializeFilters(f)
    expect(url.get('quick')).toBe('sla_at_risk,sla_breached')
    expect(parseFilters(url)).toEqual(f)
    expect(filtersFromJson(filtersToJson(f))).toEqual(f)
  })
  it('counts as active filters', () => {
    expect(hasActiveFilters({ ...emptyFilters(), quick: ['sla_breached'] })).toBe(true)
    expect(countActiveFilters({ ...emptyFilters(), quick: ['sla_breached', 'sla_at_risk'] })).toBe(2)
  })
  it('unknown quick values are dropped', () => {
    expect(parseFilters(params('quick=sla_nope,sla_breached')).quick).toEqual(['sla_breached'])
  })
})

describe('the Mentioned me chip (migration 095)', () => {
  const row = (id: string, n: number) =>
    ({
      id,
      ticket_number: n,
      subject: `S${n}`,
      description: null,
      status: 'open',
      priority: 'normal',
      category: 'general',
      assigned_agent_id: null,
      assigned_team_id: null,
      labels: [],
      due_date: null,
      updated_at: '2026-09-01T00:00:00Z',
    }) as unknown as Ticket
  const rows = [row('a', 1), row('b', 2), row('c', 3)]
  const on = { ...emptyFilters(), quick: ['mentioned' as const] }

  it('keeps exactly the tickets that wait on the person', () => {
    const ctx = { userId: 'me', prefix: 'VIR', mentionedTicketIds: new Set(['a', 'c']) }
    expect(applyFilters(rows, on, ctx).map((r) => r.ticket_number)).toEqual([1, 3])
  })

  it('shows nothing when nothing waits, or when the list is not known yet', () => {
    expect(applyFilters(rows, on, { userId: 'me', prefix: 'VIR', mentionedTicketIds: new Set() })).toEqual([])
    expect(applyFilters(rows, on, { userId: 'me', prefix: 'VIR' })).toEqual([])
  })

  it('does nothing while the chip is off', () => {
    const ctx = { userId: 'me', prefix: 'VIR', mentionedTicketIds: new Set(['a']) }
    expect(applyFilters(rows, emptyFilters(), ctx)).toHaveLength(3)
  })

  it('travels in the URL and in a saved filter', () => {
    expect(serializeFilters(on).get('quick')).toBe('mentioned')
    expect(parseFilters(params('quick=mentioned')).quick).toEqual(['mentioned'])
    expect(filtersFromJson(filtersToJson(on))).toEqual(on)
  })
})
