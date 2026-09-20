import { describe, it, expect } from 'vitest'
import type { Ticket } from '@/types'
import { UNASSIGNED } from './filters'
import { DEFAULT_SORT, groupTickets, parseGroupBy, parseSort, serializeSort, sortTickets, toggleSort } from './sort-group'

const names: Record<string, string> = { u1: 'Ada', u2: 'Bo' }
const ctx = { assigneeName: (id: string | null | undefined) => (id ? (names[id] ?? '?') : '') }

const row = (id: string, over: Partial<Ticket> = {}) =>
  ({
    id,
    ticket_number: Number(id),
    subject: `S${id}`,
    status: 'open',
    priority: 'normal',
    assigned_agent_id: null,
    due_date: null,
    updated_at: '2026-09-01T00:00:00Z',
    created_at: '2026-09-01T00:00:00Z',
    ...over,
  }) as Pick<
    Ticket,
    'id' | 'ticket_number' | 'subject' | 'status' | 'priority' | 'assigned_agent_id' | 'due_date' | 'updated_at' | 'created_at'
  >

describe('parseSort / serializeSort', () => {
  it('round-trips', () => {
    expect(parseSort(serializeSort({ key: 'due', dir: 'asc' }))).toEqual({ key: 'due', dir: 'asc' })
  })
  it('falls back to the default for junk', () => {
    expect(parseSort(null)).toEqual(DEFAULT_SORT)
    expect(parseSort('nope:asc')).toEqual(DEFAULT_SORT)
  })
  it('a missing direction means desc', () => {
    expect(parseSort('priority')).toEqual({ key: 'priority', dir: 'desc' })
  })
})

describe('toggleSort', () => {
  it('flips the direction of the active column', () => {
    expect(toggleSort({ key: 'key', dir: 'asc' }, 'key')).toEqual({ key: 'key', dir: 'desc' })
  })
  it('starts words ascending and dates newest first', () => {
    expect(toggleSort(DEFAULT_SORT, 'summary')).toEqual({ key: 'summary', dir: 'asc' })
    expect(toggleSort({ key: 'key', dir: 'asc' }, 'created')).toEqual({ key: 'created', dir: 'desc' })
  })
})

describe('sortTickets', () => {
  it('by key, both ways', () => {
    const rows = [row('2'), row('10'), row('1')]
    expect(sortTickets(rows, { key: 'key', dir: 'asc' }, ctx).map((r) => r.id)).toEqual(['1', '2', '10'])
    expect(sortTickets(rows, { key: 'key', dir: 'desc' }, ctx).map((r) => r.id)).toEqual(['10', '2', '1'])
  })
  it('by status in workflow order and priority by urgency', () => {
    const rows = [row('1', { status: 'closed' }), row('2', { status: 'in_progress' }), row('3', { status: 'open' })]
    expect(sortTickets(rows, { key: 'status', dir: 'asc' }, ctx).map((r) => r.id)).toEqual(['3', '2', '1'])
    const p = [row('1', { priority: 'low' }), row('2', { priority: 'urgent' })]
    expect(sortTickets(p, { key: 'priority', dir: 'asc' }, ctx).map((r) => r.id)).toEqual(['2', '1'])
  })
  it('no due date sorts last in either direction', () => {
    const rows = [row('1'), row('2', { due_date: '2026-10-02' }), row('3', { due_date: '2026-10-01' })]
    expect(sortTickets(rows, { key: 'due', dir: 'asc' }, ctx).map((r) => r.id)).toEqual(['3', '2', '1'])
    expect(sortTickets(rows, { key: 'due', dir: 'desc' }, ctx).map((r) => r.id)).toEqual(['2', '3', '1'])
  })
  it('unassigned sorts last, others by name', () => {
    const rows = [row('1'), row('2', { assigned_agent_id: 'u2' }), row('3', { assigned_agent_id: 'u1' })]
    expect(sortTickets(rows, { key: 'assignee', dir: 'asc' }, ctx).map((r) => r.id)).toEqual(['3', '2', '1'])
  })
  it('by updated, newest first by default', () => {
    const rows = [row('1', { updated_at: '2026-09-01T00:00:00Z' }), row('2', { updated_at: '2026-09-05T00:00:00Z' })]
    expect(sortTickets(rows, DEFAULT_SORT, ctx).map((r) => r.id)).toEqual(['2', '1'])
  })
  it('does not change the input', () => {
    const rows = [row('2'), row('1')]
    sortTickets(rows, { key: 'key', dir: 'asc' }, ctx)
    expect(rows.map((r) => r.id)).toEqual(['2', '1'])
  })
})

describe('groupTickets', () => {
  it('groups by status in workflow order', () => {
    const groups = groupTickets([row('1', { status: 'closed' }), row('2'), row('3', { status: 'closed' })], 'status', ctx)
    expect(groups.map((g) => [g.key, g.rows.map((r) => r.id)])).toEqual([
      ['open', ['2']],
      ['closed', ['1', '3']],
    ])
  })
  it('groups by priority, most urgent first', () => {
    const groups = groupTickets([row('1', { priority: 'low' }), row('2', { priority: 'urgent' })], 'priority', ctx)
    expect(groups.map((g) => g.key)).toEqual(['urgent', 'low'])
  })
  it('groups by assignee with unassigned last', () => {
    const groups = groupTickets(
      [row('1'), row('2', { assigned_agent_id: 'u2' }), row('3', { assigned_agent_id: 'u1' })],
      'assignee',
      ctx,
    )
    expect(groups.map((g) => g.key)).toEqual(['u1', 'u2', UNASSIGNED])
  })
})

describe('parseGroupBy', () => {
  it('accepts the known values only', () => {
    expect(parseGroupBy('status')).toBe('status')
    expect(parseGroupBy('x')).toBe('none')
    expect(parseGroupBy(null)).toBe('none')
  })
})

describe('SLA sort and group (migration 086)', () => {
  const NOW = Date.parse('2026-09-20T12:00:00Z')
  const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString()
  const sla = (id: string, over: Partial<Ticket>) => ({ ...row(id), ...over }) as ReturnType<typeof row> & Partial<Ticket>
  const rows = [
    sla('1', { sla_resolution_state: 'running', sla_resolution_due_at: at(300), sla_resolution_risk_at: at(200) }),
    sla('2', { sla_first_response_state: 'running', sla_first_response_due_at: at(20), sla_first_response_risk_at: at(-1) }),
    sla('3', {}),
    sla('4', { sla_first_response_state: 'running', sla_first_response_due_at: at(-15), sla_first_response_risk_at: at(-60) }),
    sla('5', { sla_resolution_state: 'paused', sla_resolution_due_at: at(10) }),
  ]
  const c = { ...ctx, now: NOW }

  it('parses "sla" as a sort key and starts ascending (soonest first)', () => {
    expect(parseSort('sla:asc')).toEqual({ key: 'sla', dir: 'asc' })
    expect(toggleSort(DEFAULT_SORT, 'sla')).toEqual({ key: 'sla', dir: 'asc' })
  })

  it('sorts by the earliest live due time; tickets with no live SLA always last', () => {
    expect(sortTickets(rows, { key: 'sla', dir: 'asc' }, c).map((r) => r.id)).toEqual(['4', '2', '1', '3', '5'])
    // descending flips the live ones but the empty ones stay at the end
    expect(sortTickets(rows, { key: 'sla', dir: 'desc' }, c).map((r) => r.id)).toEqual(['1', '2', '4', '3', '5'])
  })

  it('groups by SLA state: breached, at risk, on track, paused, met, no SLA', () => {
    const groups = groupTickets(rows, 'sla', c)
    expect(groups.map((g) => g.key)).toEqual(['breached', 'at_risk', 'on_track', 'paused', 'none'])
    expect(groups.find((g) => g.key === 'breached')!.rows.map((r) => r.id)).toEqual(['4'])
    expect(groups.find((g) => g.key === 'none')!.rows.map((r) => r.id)).toEqual(['3'])
  })

  it('the group by option is accepted from the URL', () => {
    expect(parseGroupBy('sla')).toBe('sla')
  })
})
