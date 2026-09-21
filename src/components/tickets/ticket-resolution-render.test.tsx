import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider, useTranslations } from 'next-intl'
import { beforeAll, describe, expect, it } from 'vitest'

import { ResolutionBreakdownTable } from '@/components/reports/report-panels'
import type { TicketRow } from '@/hooks/use-ticket-store'
import type { Profile, Team, Ticket } from '@/types'
import { emptyFilters } from '@/lib/tickets/filters'
import { DEFAULT_SORT } from '@/lib/tickets/sort-group'
import { TicketActivitySection } from './ticket-activity'
import { TicketDetailsCard } from './ticket-details-card'
import { TicketFilterBar } from './ticket-filter-bar'
import { TicketListView } from './ticket-list-view'
import { ResolutionFields } from './ticket-resolution-dialog'
import { StatusLozenge } from './ticket-visuals'

// Render checks for the resolution surfaces (migration 096) in English and
// Korean with the real translations: next-intl errors are thrown, so a missing
// key fails here instead of showing a raw key path.

const load = (locale: string) => JSON.parse(readFileSync(join(process.cwd(), 'messages', `${locale}.json`), 'utf8'))

function render(locale: string, node: React.ReactElement): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={load(locale)}
      onError={(e: Error) => {
        throw e
      }}
    >
      {node}
    </NextIntlClientProvider>,
  )
}

const noop = () => {}
const members = [{ id: 'p1', user_id: 'u1', full_name: 'Ada Lovelace', email: 'a@x.test', role: 'agent' }] as Profile[]
const teams: Team[] = []

const row = (n: number, over: Partial<TicketRow> = {}): TicketRow => ({
  id: `id-${n}`,
  account_id: 'a',
  ticket_number: n,
  contact_id: 'c1',
  subject: `Subject ${n}`,
  category: 'bug',
  status: 'open',
  priority: 'normal',
  assigned_agent_id: 'u1',
  assigned_team_id: null,
  created_by: 'u1',
  labels: [],
  due_date: null,
  board_rank: 1,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-19T00:00:00Z',
  contact: { id: 'c1', name: 'Grace', phone: '+100', wa_username: null, wa_user_id: null },
  comment_count: 0,
  ...over,
})

const RESOLUTIONS = [
  { id: 'r1', account_id: 'a', name: 'Fixed', position: 10, is_active: true, is_system: false, system_key: null, created_at: '', updated_at: '' },
  { id: 'r2', account_id: 'a', name: 'Old one', position: 20, is_active: false, is_system: false, system_key: null, created_at: '', updated_at: '' },
]

function card(locale: string, ticket: Partial<Ticket>, props: { resolutionName?: string | null; onEditResolution?: () => void; canWork?: boolean } = {}) {
  return render(
    locale,
    <TicketDetailsCard
      ticket={{ ...row(12), custom_fields: {}, ...ticket } as unknown as Ticket}
      contact={null}
      members={members}
      teams={teams}
      watchers={[]}
      watching={false}
      knownLabels={[]}
      canWork={props.canWork ?? true}
      currentUserId="u1"
      onUpdate={noop}
      onToggleWatch={noop}
      onViewContact={noop}
      resolutionName={props.resolutionName}
      onEditResolution={props.onEditResolution}
    />,
  )
}

describe.each(['en', 'ko'])('resolution surfaces (%s)', (locale) => {
  const m = load(locale)
  // next-intl loads the provider's context lazily; a throwaway render absorbs that (as in tickets-render.test).
  beforeAll(() => {
    try {
      render(locale, <StatusLozenge status="open" />)
    } catch {
      // only the warm-up may fail
    }
  })

  it('the details card shows the resolution and its note while the ticket is done, with a way to change it', () => {
    const html = card(locale, { status: 'resolved', resolution_id: 'r1', resolution_note: 'Restarted the sync job' }, { resolutionName: 'Fixed', onEditResolution: noop })
    expect(html).toContain('data-testid="ticket-resolution"')
    expect(html).toContain('Fixed')
    expect(html).toContain('Restarted the sync job')
    expect(html).toContain(m.Tickets.resolution.change)
  })

  it('a done ticket with no resolution says so; a read-only viewer gets no change button', () => {
    const none = card(locale, { status: 'closed', resolution_id: null }, { resolutionName: null, onEditResolution: noop, canWork: false })
    expect(none).toContain(m.Tickets.resolution.none)
    expect(none).not.toContain(m.Tickets.resolution.change)
  })

  it('a re-opened ticket keeps its resolution but does not show it', () => {
    const html = card(locale, { status: 'open', resolution_id: 'r1' }, { resolutionName: 'Fixed', onEditResolution: noop })
    expect(html).not.toContain('data-testid="ticket-resolution"')
    expect(html).not.toContain('Fixed')
  })

  it('the list has an optional Resolution column that shows the name for finished tickets only', () => {
    const rows = [
      row(1, { status: 'resolved', resolution_id: 'r1', resolution_note: 'why' }),
      row(2, { status: 'open', resolution_id: 'r1' }),
    ]
    const props = {
      rows,
      sort: DEFAULT_SORT,
      onSortChange: noop,
      groupBy: 'none' as const,
      selected: new Set<string>(),
      onSelectedChange: noop,
      canWork: true,
      keyOf: (n: number) => `VIR-${n}`,
      members,
      nameOf: () => '',
      onOpen: noop,
      onPatch: noop,
      hasMore: false,
      loadingMore: false,
      onLoadMore: noop,
      resolutionName: (id: string) => RESOLUTIONS.find((r) => r.id === id)?.name ?? null,
    }
    const off = render(locale, <TicketListView {...props} />)
    expect(off).not.toContain(m.Tickets.list.col.resolution)
    const on = render(locale, <TicketListView {...props} showResolution />)
    expect(on).toContain(m.Tickets.list.col.resolution)
    expect(on.match(/Fixed/g)?.length).toBe(1)
  })

  it('the filter bar offers a Resolution filter once the account has resolutions', () => {
    const base = { filters: emptyFilters(), onChange: noop, view: 'list' as const, members, teams, knownLabels: [] }
    expect(render(locale, <TicketFilterBar {...base} />)).not.toContain(`>${m.Tickets.filters.resolution}`)
    expect(render(locale, <TicketFilterBar {...base} resolutions={RESOLUTIONS} />)).toContain(m.Tickets.filters.resolution)
  })

  it('the history says "resolved as" with the note, by a person or by the system', () => {
    const html = render(
      locale,
      <TicketActivitySection
        comments={[]}
        activity={[
          { id: 'e1', ticket_id: 'id-12', account_id: 'a', actor_id: 'u1', event_type: 'resolved_as', to_value: 'Fixed', detail: 'Restarted the sync job', created_at: '2026-09-19T00:00:00Z' },
          { id: 'e2', ticket_id: 'id-12', account_id: 'a', actor_id: null, event_type: 'resolved_as', to_value: 'Resolved in Jira', detail: null, created_at: '2026-09-19T01:00:00Z' },
          { id: 'e3', ticket_id: 'id-12', account_id: 'a', actor_id: 'u1', event_type: 'resolution_changed', from_value: 'Fixed', to_value: 'Duplicate', detail: null, created_at: '2026-09-19T02:00:00Z' },
          { id: 'e4', ticket_id: 'id-12', account_id: 'a', actor_id: 'u1', event_type: 'resolution_changed', from_value: 'Fixed', to_value: 'Fixed', detail: 'new note', created_at: '2026-09-19T03:00:00Z' },
          { id: 'e5', ticket_id: 'id-12', account_id: 'a', actor_id: 'u1', event_type: 'resolution_changed', from_value: null, to_value: 'Fixed', detail: null, created_at: '2026-09-19T04:00:00Z' },
        ]}
        members={members}
        teams={teams}
        fieldDefs={[]}
        linked={{}}
        keyOf={(n) => `VIR-${n}`}
        canWork
        currentUserId="u1"
        onAddComment={async () => true}
        onEditComment={async () => true}
        onDeleteComment={async () => true}
      />,
    )
    expect(html).toContain(m.Tickets.detail.activity.resolvedAs.replace('{resolution}', 'Fixed'))
    expect(html).toContain(m.Tickets.detail.activity.resolvedAsSystem.replace('{resolution}', 'Resolved in Jira'))
    expect(html).toContain(m.Tickets.detail.activity.resolutionNoteChanged)
    expect(html).toContain(m.Tickets.detail.activity.resolutionSet.replace('{to}', 'Fixed'))
    expect(html).toContain('Restarted the sync job')
    expect(html).toContain('new note')
  })

  it('the dialog fields: a placeholder until one is chosen, then its name; a note counter; an empty catalogue explains itself', () => {
    const fields = (over: Partial<React.ComponentProps<typeof ResolutionFields>> = {}) =>
      render(
        locale,
        <ResolutionFields resolutions={[RESOLUTIONS[0]]} resolutionId={null} onResolutionChange={noop} note="" onNoteChange={noop} {...over} />,
      )
    expect(fields()).toContain(m.Tickets.resolution.placeholder)
    expect(fields({ resolutionId: 'r1' })).toContain('Fixed')
    expect(fields({ resolutionId: 'r1' })).not.toContain(m.Tickets.resolution.placeholder)
    expect(fields({ note: 'abc' })).toContain(m.Tickets.resolution.noteCount.replace('{count}', '3').replace('{max}', '2000'))
    expect(fields({ note: 'x'.repeat(2001) })).toContain(m.Tickets.resolution.problem.noteTooLong)
    expect(fields({ resolutions: [] })).toContain(m.Tickets.resolution.empty)
  })

  it('the report table lists resolutions with counts and shares, and the no-resolution row', () => {
    function Table() {
      const t = useTranslations('Reports.tickets')
      return (
        <ResolutionBreakdownTable
          t={t}
          rows={[
            { key: 'r1', label: 'Fixed', resolved: 3, sharePct: 75 },
            { key: '', label: null, resolved: 1, sharePct: 25 },
          ]}
        />
      )
    }
    const html = render(locale, <Table />)
    expect(html).toContain(m.Reports.tickets.byResolution)
    expect(html).toContain('Fixed')
    expect(html).toContain('75%')
    expect(html).toContain(m.Reports.tickets.noResolution)
    function Empty() {
      return <ResolutionBreakdownTable t={useTranslations('Reports.tickets')} rows={[]} />
    }
    expect(render(locale, <Empty />)).toContain(m.Reports.tickets.noBreakdownData)
  })
})

describe('resolution strings: English and Korean agree', () => {
  const leaves = (node: unknown, prefix = ''): string[] =>
    typeof node === 'string'
      ? [prefix]
      : Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k))
  it.each(['Tickets.resolution', 'Settings.ticketResolutions'])('%s has the same keys in both languages', (path) => {
    const at = (root: Record<string, unknown>) => path.split('.').reduce<unknown>((n, k) => (n as Record<string, unknown>)[k], root)
    expect(leaves(at(load('ko'))).sort()).toEqual(leaves(at(load('en'))).sort())
  })
})
