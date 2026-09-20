import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { beforeAll, describe, expect, it } from 'vitest'

import type { TicketRow } from '@/hooks/use-ticket-store'
import type { Profile, Team, Ticket, TicketLink } from '@/types'
import { TicketActivitySection } from './ticket-activity'
import { TicketAttachmentsSection } from './ticket-attachments'
import { TicketBoard } from './ticket-board'
import { TicketBulkBar } from './ticket-bulk-bar'
import { TicketDetailsCard } from './ticket-details-card'
import { TicketFilterBar } from './ticket-filter-bar'
import { TicketLabelPicker } from './ticket-label-picker'
import { TicketLinksSection } from './ticket-links'
import { TicketListView } from './ticket-list-view'
import { DueChip, StatusLozenge } from './ticket-visuals'
import { emptyFilters } from '@/lib/tickets/filters'
import { DEFAULT_SORT } from '@/lib/tickets/sort-group'

// Render smoke tests: every ticket surface renders in English and Korean with
// its real translations. next-intl errors (a missing key, a missing argument)
// are thrown instead of logged, so a string that is not in the catalogue, or a
// component that reads the wrong namespace, fails here rather than showing a raw
// key path to an agent.

const load = (locale: string) =>
  JSON.parse(readFileSync(join(process.cwd(), 'messages', `${locale}.json`), 'utf8'))

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

const keyOf = (n: number) => `VIR-${n}`
const noop = () => {}

const members = [
  { id: 'p1', user_id: 'u1', full_name: 'Ada Lovelace', email: 'a@x.test', role: 'agent' },
  { id: 'p2', user_id: 'u2', full_name: 'Bo Chen', email: 'b@x.test', role: 'agent' },
] as Profile[]
const teams = [{ id: 't1', account_id: 'a', name: 'Payments', color: '#000', created_at: '', updated_at: '' }] as Team[]

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
  created_by: 'u2',
  labels: ['vip', 'billing'],
  due_date: '2020-01-01',
  board_rank: 100 - n,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-19T00:00:00Z',
  contact: { id: 'c1', name: 'Grace Hopper', phone: '+100', wa_username: null, wa_user_id: null },
  comment_count: 2,
  ...over,
})

const rows = [row(12), row(13, { status: 'in_progress', priority: 'low', due_date: null }), row(14, { status: 'resolved' })]
const totals = { open: 1, in_progress: 1, pending: 0, resolved: 1, closed: 4 }
const loaded = { open: 1, in_progress: 1, pending: 0, resolved: 1, closed: 0 }
const loadedFlags = { open: true, in_progress: true, pending: true, resolved: true, closed: false }

describe.each(['en', 'ko'])('ticket surfaces render with %s messages', (locale) => {
  // The first component to call useTranslations in a process renders without
  // the provider's context (next-intl loads it lazily); a throwaway render
  // absorbs that so the real tests below see the same thing every time.
  beforeAll(() => {
    try {
      render(locale, <StatusLozenge status="open" />)
    } catch {
      // only the warm-up may fail
    }
  })

  it('the board: columns, cards, empty placeholder, collapsed Closed', () => {
    const html = render(
      locale,
      <TicketBoard
        rows={rows}
        totals={totals}
        loadedCounts={loaded}
        columnLoaded={loadedFlags}
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
    expect(html).toContain('VIR-12')
    expect(html).toContain('Subject 13')
    expect(html).toContain('Grace Hopper')
    // the pending column is empty, so it shows the drop placeholder
    expect(html).toContain(load(locale).Tickets.board.dropHere)
    expect(html).toContain(load(locale).Tickets.common.status.in_progress)
  })

  it('the list: rows, sortable headings, groups', () => {
    const html = render(
      locale,
      <TicketListView
        rows={rows}
        sort={DEFAULT_SORT}
        onSortChange={noop}
        groupBy="status"
        selected={new Set(['id-12'])}
        onSelectedChange={noop}
        canWork
        keyOf={keyOf}
        members={members}
        nameOf={(id) => members.find((m) => m.user_id === id)?.full_name ?? ''}
        onOpen={noop}
        onPatch={noop}
        hasMore
        loadingMore={false}
        onLoadMore={noop}
      />,
    )
    expect(html).toContain('VIR-13')
    expect(html).toContain('aria-sort="descending"')
    expect(html).toContain(load(locale).Tickets.list.loadMore)
  })

  it('the filter bar and the bulk bar', () => {
    const bar = render(
      locale,
      <TicketFilterBar
        filters={{ ...emptyFilters(), quick: ['mine'], statuses: ['open'] }}
        onChange={noop}
        view="list"
        members={members}
        teams={teams}
        knownLabels={['vip']}
      />,
    )
    expect(bar).toContain('aria-pressed="true"')
    const bulk = render(
      locale,
      <TicketBulkBar
        count={3}
        members={members}
        teams={teams}
        knownLabels={[{ label: 'vip', uses: 2 }]}
        canDelete
        busy={false}
        onApply={noop}
        onDelete={noop}
        onClear={noop}
      />,
    )
    expect(bulk).toContain(load(locale).Tickets.bulk.delete)
  })

  it('the details card, activity, links, attachments and labels', () => {
    const ticket = { ...row(12), custom_fields: {} } as unknown as Ticket
    const card = render(
      locale,
      <TicketDetailsCard
        ticket={ticket}
        contact={null}
        members={members}
        teams={teams}
        watchers={[{ ticket_id: 'id-12', user_id: 'u1', account_id: 'a', created_at: '2026-09-01T00:00:00Z' }]}
        watching={false}
        knownLabels={[]}
        canWork
        currentUserId="u2"
        onUpdate={noop}
        onToggleWatch={noop}
        onViewContact={noop}
      />,
    )
    expect(card).toContain('vip')
    expect(card).toContain('Ada Lovelace')

    const activity = render(
      locale,
      <TicketActivitySection
        comments={[
          { id: 'c1', ticket_id: 'id-12', account_id: 'a', author_id: 'u1', body: 'Hello', mentions: [], created_at: '2026-09-19T00:00:00Z', edited_at: '2026-09-19T01:00:00Z' },
        ]}
        activity={[
          { id: 'e1', ticket_id: 'id-12', account_id: 'a', actor_id: 'u1', event_type: 'due_date_changed', from_value: null, to_value: '2026-10-01', created_at: '2026-09-19T00:00:00Z' },
          { id: 'e2', ticket_id: 'id-12', account_id: 'a', actor_id: 'u1', event_type: 'labels_changed', from_value: 'a', to_value: 'a,b', created_at: '2026-09-19T00:00:00Z' },
          { id: 'e3', ticket_id: 'id-12', account_id: 'a', actor_id: 'u1', event_type: 'link_added', from_value: 'blocked_by', to_value: 'id-13', created_at: '2026-09-19T00:00:00Z' },
          { id: 'e4', ticket_id: 'id-12', account_id: 'a', actor_id: 'u1', event_type: 'status_changed', from_value: 'open', to_value: 'in_progress', created_at: '2026-09-19T00:00:00Z' },
          { id: 'e5', ticket_id: 'id-12', account_id: 'a', actor_id: 'u1', event_type: 'summary_changed', from_value: 'x', to_value: 'y', created_at: '2026-09-19T00:00:00Z' },
          { id: 'e6', ticket_id: 'id-12', account_id: 'a', actor_id: 'u1', event_type: 'description_changed', created_at: '2026-09-19T00:00:00Z' },
          { id: 'e7', ticket_id: 'id-12', account_id: 'a', actor_id: 'u1', event_type: 'attachment_added', to_value: 'x.png', created_at: '2026-09-19T00:00:00Z' },
        ]}
        members={members}
        teams={teams}
        fieldDefs={[]}
        linked={{ 'id-13': { id: 'id-13', ticket_number: 13, subject: 'S', status: 'open', category: 'bug' } }}
        keyOf={keyOf}
        canWork
        currentUserId="u1"
        onAddComment={async () => true}
        onEditComment={async () => true}
        onDeleteComment={async () => true}
      />,
    )
    expect(activity).toContain('VIR-13')
    expect(activity).toContain('Hello')

    const links = render(
      locale,
      <TicketLinksSection
        ticketId="id-12"
        links={[{ id: 'l1', account_id: 'a', from_ticket_id: 'id-13', to_ticket_id: 'id-12', link_type: 'blocks', created_at: '' } as TicketLink]}
        linked={{ 'id-13': { id: 'id-13', ticket_number: 13, subject: 'Other', status: 'open', category: 'bug' } }}
        keyOf={keyOf}
        canWork
        onAdd={async () => true}
        onRemove={noop}
        onOpenTicket={noop}
      />,
    )
    expect(links).toContain(load(locale).Tickets.links.group.blocked_by)

    const files = render(
      locale,
      <TicketAttachmentsSection
        attachments={[
          { id: 'f1', ticket_id: 'id-12', account_id: 'a', storage_path: 'p', url: 'https://x.test/a.png', filename: 'a.png', mime_type: 'image/png', size_bytes: 10, created_at: '2026-01-01' },
          { id: 'f2', ticket_id: 'id-12', account_id: 'a', storage_path: 'p', url: 'https://x.test/b.pdf', filename: 'b.pdf', mime_type: 'application/pdf', size_bytes: 2048, created_at: '2026-01-02' },
        ]}
        uploading={[{ key: 'k', name: 'c.png' }]}
        canWork
        canRemove={() => true}
        onAddFiles={noop}
        onRemove={noop}
      />,
    )
    expect(files).toContain('b.pdf')

    const labels = render(locale, <TicketLabelPicker labels={['vip']} known={[]} onChange={noop} />)
    expect(labels).toContain('vip')
  })

  it('read-only viewers get disabled controls, not a missing screen', () => {
    const html = render(
      locale,
      <TicketListView
        rows={rows}
        sort={DEFAULT_SORT}
        onSortChange={noop}
        groupBy="none"
        selected={new Set()}
        onSelectedChange={noop}
        canWork={false}
        keyOf={keyOf}
        members={members}
        nameOf={() => ''}
        onOpen={noop}
        onPatch={noop}
        hasMore={false}
        loadingMore={false}
        onLoadMore={noop}
      />,
    )
    expect(html).toContain('VIR-12')
    expect(html).toContain('disabled')
  })

  it('lozenge and due chip', () => {
    const html = render(
      locale,
      <div>
        <StatusLozenge status="in_progress" />
        <DueChip dueDate="2020-01-01" status="open" now={new Date(2026, 8, 20)} />
        <DueChip dueDate="2020-01-01" status="closed" now={new Date(2026, 8, 20)} />
      </div>,
    )
    expect(html).toContain(load(locale).Tickets.common.status.in_progress)
    // overdue is red; a closed ticket with the same date is not
    expect(html.match(/text-red-700/g)?.length).toBe(1)
  })
})
