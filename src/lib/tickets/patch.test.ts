import { describe, it, expect } from 'vitest'
import type { TicketPriority, TicketStatus } from '@/types'
import { buildBulkUpdates, buildTicketPatch, statusPatch } from './patch'

const now = new Date('2026-09-20T08:00:00.000Z')
const STAMP = '2026-09-20T08:00:00.000Z'

describe('statusPatch', () => {
  it('stamps resolved_at when resolving and leaves closed_at alone', () => {
    expect(statusPatch('resolved', now)).toEqual({ status: 'resolved', resolved_at: STAMP, closed_at: undefined })
  })
  it('stamps closed_at when closing', () => {
    expect(statusPatch('closed', now)).toEqual({ status: 'closed', resolved_at: undefined, closed_at: STAMP })
  })
  it('clears both when moving back to an active status', () => {
    for (const s of ['open', 'in_progress', 'pending'] as const) {
      expect(statusPatch(s, now)).toEqual({ status: s, resolved_at: null, closed_at: null })
    }
  })
})

describe('buildTicketPatch', () => {
  it('adds the timestamps that go with a status change and drops the undefined ones', () => {
    expect(buildTicketPatch({ status: 'resolved' }, now)).toEqual({ status: 'resolved', resolved_at: STAMP })
    expect(buildTicketPatch({ status: 'pending' }, now)).toEqual({
      status: 'pending',
      resolved_at: null,
      closed_at: null,
    })
  })
  it('leaves other fields alone', () => {
    expect(buildTicketPatch({ priority: 'high' }, now)).toEqual({ priority: 'high' })
  })
  it('respects timestamps the caller already set', () => {
    expect(buildTicketPatch({ status: 'resolved', resolved_at: 'x' }, now)).toEqual({
      status: 'resolved',
      resolved_at: 'x',
    })
  })
})

describe('buildBulkUpdates', () => {
  const row = (
    id: string,
    over: Partial<{
      status: TicketStatus
      priority: TicketPriority
      assigned_agent_id: string | null
      assigned_team_id: string | null
      labels: string[]
    }> = {},
  ) => ({
    id,
    status: 'open' as TicketStatus,
    priority: 'normal' as TicketPriority,
    assigned_agent_id: null,
    assigned_team_id: null,
    labels: [] as string[],
    ...over,
  })

  it('one update per field, skipping rows that already have the value', () => {
    const plan = buildBulkUpdates(
      { kind: 'status', status: 'resolved' },
      [row('1'), row('2', { status: 'resolved' }), row('3')],
      now,
    )
    expect(plan.updates).toEqual([{ ids: ['1', '3'], patch: { status: 'resolved', resolved_at: STAMP } }])
    expect(plan.skipped).toBe(1)
    expect(plan.changed).toBe(2)
  })
  it('assigns and unassigns', () => {
    expect(buildBulkUpdates({ kind: 'assignee', userId: 'u1' }, [row('1'), row('2')]).updates).toEqual([
      { ids: ['1', '2'], patch: { assigned_agent_id: 'u1' } },
    ])
    const plan = buildBulkUpdates({ kind: 'assignee', userId: null }, [row('1'), row('2', { assigned_agent_id: 'u1' })])
    expect(plan.updates).toEqual([{ ids: ['2'], patch: { assigned_agent_id: null } }])
  })
  it('sets priority and team', () => {
    expect(buildBulkUpdates({ kind: 'priority', priority: 'urgent' }, [row('1')]).updates[0].patch).toEqual({
      priority: 'urgent',
    })
    expect(buildBulkUpdates({ kind: 'team', teamId: 't1' }, [row('1')]).updates[0].patch).toEqual({
      assigned_team_id: 't1',
    })
  })
  it('adds a label per distinct resulting list', () => {
    const plan = buildBulkUpdates({ kind: 'label', label: ' VIP ' }, [
      row('1'),
      row('2'),
      row('3', { labels: ['bug'] }),
      row('4', { labels: ['vip'] }),
    ])
    expect(plan.updates).toEqual([
      { ids: ['1', '2'], patch: { labels: ['vip'] } },
      { ids: ['3'], patch: { labels: ['bug', 'vip'] } },
    ])
    expect(plan.skipped).toBe(1)
    expect(plan.changed).toBe(3)
  })
  it('skips tickets already at ten labels', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `l${i}`)
    const plan = buildBulkUpdates({ kind: 'label', label: 'new' }, [row('1', { labels: ten })])
    expect(plan).toEqual({ updates: [], skipped: 1, changed: 0 })
  })
  it('does nothing when every row already matches', () => {
    expect(buildBulkUpdates({ kind: 'priority', priority: 'normal' }, [row('1')])).toEqual({
      updates: [],
      skipped: 1,
      changed: 0,
    })
  })
})
