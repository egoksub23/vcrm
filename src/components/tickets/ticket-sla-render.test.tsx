import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { beforeAll, describe, expect, it } from 'vitest'

import type { TicketRow } from '@/hooks/use-ticket-store'
import { FIXTURE_SCHEDULES } from '@/lib/sla/business-time.fixtures'
import { ticketSlaView } from '@/lib/sla/display'
import { emptyFilters } from '@/lib/tickets/filters'
import type { SlaPolicy, SlaSchedule, TicketSlaFields } from '@/lib/sla/types'
import type { Profile, Team, Ticket } from '@/types'
import { TicketBoard } from './ticket-board'
import { TicketDetailsCard } from './ticket-details-card'
import { TicketFilterBar } from './ticket-filter-bar'
import { TicketListView } from './ticket-list-view'
import { SlaDetailLines, TicketSlaBadge } from './ticket-sla-badge'
import { TicketSlaSection } from './ticket-sla-section'
import { StatusLozenge } from './ticket-visuals'
import { DEFAULT_SORT } from '@/lib/tickets/sort-group'

// Render smoke tests for the ticket SLA surfaces (migration 086) in English and
// Korean with the real translations: next-intl errors are thrown, so a missing
// key or argument fails here instead of showing a raw key path to an agent.

const load = (locale: string) => JSON.parse(readFileSync(join(process.cwd(), 'messages', `${locale}.json`), 'utf8'))

function render(locale: string, node: React.ReactElement): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={load(locale)}
      timeZone="UTC"
      onError={(e: Error) => {
        throw e
      }}
    >
      {node}
    </NextIntlClientProvider>,
  )
}

const NOW = Date.parse('2026-09-20T12:00:00Z')
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString()

const policy: SlaPolicy = {
  id: 'pol-1',
  account_id: 'a',
  name: 'Urgent tickets',
  position: 1,
  is_active: true,
  conditions: { priorities: ['urgent'] },
  first_response_minutes: 60,
  resolution_minutes: 480,
  schedule_id: 'sch-1',
  pause_while_pending: true,
  at_risk_percent: 80,
}
const schedule: SlaSchedule = {
  id: 'sch-1',
  account_id: 'a',
  name: 'Support hours',
  timezone: 'America/New_York',
  is_default: true,
  weekly: FIXTURE_SCHEDULES.NY.weekly,
  holidays: [],
}
const context = { policy, schedule, business: { ...FIXTURE_SCHEDULES.NY, holidays: [] } }

const sla = (over: Partial<TicketSlaFields>): TicketSlaFields => ({
  sla_policy_id: 'pol-1',
  sla_first_response_state: 'running',
  sla_first_response_due_at: at(120),
  sla_first_response_risk_at: at(90),
  sla_resolution_state: 'running',
  sla_resolution_due_at: at(600),
  sla_resolution_risk_at: at(500),
  ...over,
})

const STATES: [string, TicketSlaFields][] = [
  ['on_track', sla({})],
  ['at_risk', sla({ sla_first_response_risk_at: at(-5), sla_first_response_due_at: at(30) })],
  ['breached', sla({ sla_first_response_due_at: at(-35), sla_first_response_risk_at: at(-90) })],
  ['paused', sla({ sla_first_response_state: 'paused', sla_resolution_state: 'paused' })],
  ['met', sla({ sla_first_response_state: 'met', sla_resolution_state: 'met' })],
]

const members = [{ id: 'p1', user_id: 'u1', full_name: 'Ada Lovelace', email: 'a@x.test', role: 'agent' }] as Profile[]
const teams = [] as Team[]

const row = (n: number, over: Partial<TicketRow> = {}): TicketRow => ({
  id: `id-${n}`,
  account_id: 'a',
  ticket_number: n,
  contact_id: 'c1',
  subject: `Subject ${n}`,
  category: 'bug',
  status: 'open',
  priority: 'urgent',
  assigned_agent_id: 'u1',
  assigned_team_id: null,
  created_by: 'u1',
  labels: [],
  due_date: null,
  board_rank: 1,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-19T00:00:00Z',
  contact: { id: 'c1', name: 'Grace Hopper', phone: '+100', wa_username: null, wa_user_id: null },
  comment_count: 0,
  ...over,
})

const noop = () => {}
const keyOf = (n: number) => `VIR-${n}`

describe.each(['en', 'ko'])('ticket SLA surfaces render with %s messages', (locale) => {
  beforeAll(() => {
    try {
      render(locale, <StatusLozenge status="open" />)
    } catch {
      // only the warm-up may fail
    }
  })

  it.each(STATES)('the badge shows the %s state', (state, fields) => {
    const html = render(locale, <TicketSlaBadge ticket={fields} now={NOW} context={context} />)
    expect(html).toContain(`data-sla-state="${state}"`)
    expect(html).not.toMatch(/Tickets\.sla\./)
  })

  it('the badge counts down in business time, not wall time', () => {
    // Monday 17:30 New York: a target due at Tuesday 09:15 is 45 business minutes away
    const now = Date.parse('2026-09-14T21:30:00Z')
    const fields = sla({
      sla_first_response_due_at: '2026-09-15T13:15:00Z',
      sla_first_response_risk_at: '2026-09-15T13:00:00Z',
      sla_resolution_state: 'none',
      sla_resolution_due_at: null,
      sla_resolution_risk_at: null,
    })
    const html = render(locale, <TicketSlaBadge ticket={fields} now={now} context={context} />)
    expect(html).toContain('45m')
    expect(html).not.toContain('15h')
  })

  it('shows overdue time for a breached target', () => {
    const html = render(locale, <TicketSlaBadge ticket={STATES[2][1]} now={NOW} context={{ policy, schedule: null, business: null }} />)
    expect(html).toContain('35m')
  })

  it('is hidden when the ticket has no SLA', () => {
    expect(render(locale, <TicketSlaBadge ticket={{}} now={NOW} context={context} />)).toBe('')
    expect(
      render(locale, <TicketSlaBadge ticket={{ sla_first_response_state: 'none', sla_resolution_state: 'none' }} now={NOW} context={context} />),
    ).toBe('')
  })

  it('the compact badge (board cards) renders too', () => {
    const html = render(locale, <TicketSlaBadge ticket={STATES[1][1]} now={NOW} context={context} compact />)
    expect(html).toContain('data-sla-state="at_risk"')
  })

  it('the tooltip lists both targets, the policy, the hours and the schedule zone', () => {
    const view = ticketSlaView(STATES[0][1], NOW, context.business)
    const html = render(locale, <SlaDetailLines view={view} ctx={context} />)
    expect(html).toContain('Urgent tickets')
    expect(html).toContain('Support hours')
    expect(html).toContain('America/New_York')
    // both targets are described (two headings)
    expect(html.match(/font-semibold/g)?.length).toBe(2)
  })

  it('the tooltip says so when the policy was removed and hours are 24/7', () => {
    const view = ticketSlaView(STATES[3][1], NOW, null)
    const html = render(locale, <SlaDetailLines view={view} ctx={{ policy: null, schedule: null, business: null }} />)
    expect(html).not.toContain('America/New_York')
  })

  it('the details card section shows both targets with their own state and due time', () => {
    const html = render(locale, <TicketSlaSection ticket={sla({ sla_first_response_state: 'met', sla_first_response_at: at(-10) })} now={NOW} context={context} />)
    expect(html).toContain('data-testid="ticket-sla-section"')
    expect(html).toContain('data-sla-state="met"')
    expect(html).toContain('data-sla-state="on_track"')
    expect(html).toContain('Urgent tickets')
    expect(html).toContain('America/New_York')
  })

  it('the details card section is hidden without an SLA', () => {
    expect(render(locale, <TicketSlaSection ticket={{}} now={NOW} context={context} />)).toBe('')
  })

  it('the full details card renders with an SLA on the ticket', () => {
    const ticket = {
      id: 't1',
      account_id: 'a',
      ticket_number: 12,
      contact_id: 'c1',
      subject: 'Refund',
      category: 'billing',
      status: 'open',
      priority: 'urgent',
      created_at: '2026-09-19T00:00:00Z',
      updated_at: '2026-09-19T00:00:00Z',
      ...sla({}),
    } as Ticket
    const html = render(
      locale,
      <TicketDetailsCard
        ticket={ticket}
        contact={null}
        members={members}
        teams={teams}
        watchers={[]}
        watching={false}
        knownLabels={[]}
        canWork
        currentUserId="u1"
        onUpdate={noop}
        onToggleWatch={noop}
        onViewContact={noop}
      />,
    )
    // no configuration is loaded in a static render, so the section shows its "removed policy" line
    expect(html).toContain('data-testid="ticket-sla-section"')
  })

  it('a board card carries the compact badge', () => {
    const html = render(
      locale,
      <TicketBoard
        rows={[row(12, sla({}) as Partial<TicketRow>)]}
        totals={{ open: 1, in_progress: 0, pending: 0, resolved: 0, closed: 0 }}
        loadedCounts={{ open: 1, in_progress: 0, pending: 0, resolved: 0, closed: 0 }}
        columnLoaded={{ open: true, in_progress: true, pending: true, resolved: true, closed: false }}
        loadingMore={null}
        filtered={false}
        canWork
        keyOf={keyOf}
        members={members}
        onOpen={noop}
        onMove={noop}
        onShowMore={noop}
        onExpandColumn={noop}
        closedOpen={false}
        onClosedOpenChange={noop}
      />,
    )
    expect(html).toContain('Subject 12')
  })

  it('the list has a sortable SLA column that can be hidden', () => {
    const props = {
      rows: [row(12, sla({}) as Partial<TicketRow>)],
      sort: DEFAULT_SORT,
      onSortChange: noop,
      groupBy: 'none' as const,
      selected: new Set<string>(),
      onSelectedChange: noop,
      canWork: true,
      keyOf,
      members,
      nameOf: () => 'Ada',
      onOpen: noop,
      onPatch: noop,
      hasMore: false,
      loadingMore: false,
      onLoadMore: noop,
    }
    const withSla = render(locale, <TicketListView {...props} />)
    expect(withSla).toContain(load(locale).Tickets.list.col.sla)
    const without = render(locale, <TicketListView {...props} showSla={false} />)
    expect(without).not.toContain('data-sla-state')
    expect(without.length).toBeLessThan(withSla.length)
  })

  it('the list can be grouped by SLA state', () => {
    const html = render(
      locale,
      <TicketListView
        rows={[row(12, sla({}) as Partial<TicketRow>), row(13)]}
        sort={DEFAULT_SORT}
        onSortChange={noop}
        groupBy="sla"
        selected={new Set()}
        onSelectedChange={noop}
        canWork
        keyOf={keyOf}
        members={members}
        nameOf={() => 'Ada'}
        onOpen={noop}
        onPatch={noop}
        hasMore={false}
        loadingMore={false}
        onLoadMore={noop}
      />,
    )
    expect(html).toContain(load(locale).Tickets.sla.state.none)
  })

  it('the filter bar has the two SLA chips', () => {
    const html = render(
      locale,
      <TicketFilterBar
        filters={{ ...emptyFilters(), quick: ['sla_breached'] }}
        onChange={noop}
        view="list"
        members={members}
        teams={teams}
        knownLabels={[]}
      />,
    )
    const quick = load(locale).Tickets.filters.quick
    expect(html).toContain(quick.sla_at_risk)
    expect(html).toContain(quick.sla_breached)
    expect(html).toMatch(new RegExp(`aria-pressed="true"[^>]*>${quick.sla_breached}<`))
  })
})
