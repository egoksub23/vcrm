import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { beforeAll, describe, expect, it } from 'vitest'

import type { TicketRow } from '@/hooks/use-ticket-store'
import type { Profile, Team, TicketActivity, TicketComment, TicketMention } from '@/types'
import { TicketActivitySection } from './ticket-activity'
import { TicketBoard } from './ticket-board'
import { TicketFilterBar } from './ticket-filter-bar'
import { TicketListView } from './ticket-list-view'
import { TicketMentionBanner } from './ticket-mention-banner'
import { TicketsWaitingBadge } from './tickets-waiting-badge'
import { WaitingOnYouChip } from './ticket-waiting-chip'
import { StatusLozenge } from './ticket-visuals'
import { emptyFilters } from '@/lib/tickets/filters'
import { DEFAULT_SORT } from '@/lib/tickets/sort-group'

// Render smoke tests for the ticket @mention surfaces (migration 095), in English
// and Korean with the real catalogues. next-intl errors (a missing key or
// argument) are thrown, so a string that is not in the catalogue fails here
// rather than showing a raw key path to an agent.

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
const keyOf = (n: number) => `VIR-${n}`

const members = [
  { id: 'p1', user_id: 'u1', full_name: 'Ada Lovelace', email: 'a@x.test', role: 'agent' },
  { id: 'p2', user_id: 'u2', full_name: 'Bo Chen', email: 'b@x.test', role: 'agent' },
] as Profile[]
const teams = [{ id: 't1', account_id: 'a', name: 'Support Team', color: '#000', created_at: '', updated_at: '' }] as Team[]

const row = (n: number): TicketRow => ({
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
  created_by: 'u2',
  labels: [],
  due_date: null,
  board_rank: 1,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-19T00:00:00Z',
  contact: { id: 'c1', name: 'Grace Hopper', phone: '+100', wa_username: null, wa_user_id: null },
  comment_count: 0,
})

const request = (over: Partial<TicketMention> = {}): TicketMention => ({
  id: 'm1',
  account_id: 'a',
  ticket_id: 'id-12',
  comment_id: 'c1',
  mentioned_user_id: 'u1',
  requested_by: 'u2',
  via_team_id: null,
  kind: 'response',
  status: 'open',
  created_at: '2026-09-19T00:00:00Z',
  resolved_at: null,
  resolved_by: null,
  resolved_reason: null,
  nudged_at: null,
  ...over,
})

describe.each(['en', 'ko'])('ticket mention surfaces render with %s messages', (locale) => {
  const m = load(locale).Tickets.detail.mention

  beforeAll(() => {
    try {
      render(locale, <StatusLozenge status="open" />)
    } catch {
      // only the warm-up may fail
    }
  })

  it('the sidebar bubble: the count, "9+" past nine, nothing at zero', () => {
    const one = render(locale, <TicketsWaitingBadge count={3} />)
    expect(one).toContain('data-tickets-waiting-badge="yes"')
    expect(one).toMatch(/>3<\/span>/)
    expect(one).toContain('aria-label=')

    expect(render(locale, <TicketsWaitingBadge count={12} />)).toMatch(/>9\+<\/span>/)
    expect(render(locale, <TicketsWaitingBadge count={0} />)).toBe('')
  })

  it('the Waiting on you chip says who asked and how long ago', () => {
    const html = render(locale, <WaitingOnYouChip request={request()} members={members} detail />)
    expect(html).toContain('data-waiting-on-you="yes"')
    expect(html).toContain(m.waitingOnYou)
    expect(html).toContain('Bo Chen')
  })

  it('the board card and the list row show the chip only on tickets that wait', () => {
    const rows = [row(12), row(13)]
    const waiting = { 'id-12': request() }
    const board = render(
      locale,
      <TicketBoard
        rows={rows}
        totals={{ open: 2, in_progress: 0, pending: 0, resolved: 0, closed: 0 }}
        loadedCounts={{ open: 2, in_progress: 0, pending: 0, resolved: 0, closed: 0 }}
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
        waiting={waiting}
      />,
    )
    expect(board.match(/data-waiting-on-you="yes"/g)?.length).toBe(1)

    const list = render(
      locale,
      <TicketListView
        rows={rows}
        sort={DEFAULT_SORT}
        onSortChange={noop}
        groupBy="none"
        selected={new Set()}
        onSelectedChange={noop}
        canWork
        keyOf={keyOf}
        members={members}
        nameOf={(id) => members.find((p) => p.user_id === id)?.full_name ?? ''}
        onOpen={noop}
        onPatch={noop}
        hasMore={false}
        loadingMore={false}
        onLoadMore={noop}
        waiting={waiting}
      />,
    )
    expect(list.match(/data-waiting-on-you="yes"/g)?.length).toBe(1)
  })

  it('the filter bar has a Mentioned me chip with its count', () => {
    const html = render(
      locale,
      <TicketFilterBar
        filters={{ ...emptyFilters(), quick: ['mentioned'] }}
        onChange={noop}
        view="list"
        members={members}
        teams={teams}
        knownLabels={[]}
        mentionedCount={2}
      />,
    )
    expect(html).toContain(load(locale).Tickets.filters.quick.mentioned)
    expect(html).toMatch(/aria-pressed="true"[^>]*>[^<]*<span[^>]*>2<\/span>/)
  })

  it('the banner: a request for you with Mark as done, and who you are waiting on', () => {
    const html = render(
      locale,
      <TicketMentionBanner
        requests={[
          request({ id: 'm1', mentioned_user_id: 'u1', requested_by: 'u2', via_team_id: 't1' }),
          request({ id: 'm2', mentioned_user_id: 'u2', requested_by: 'u1' }),
        ]}
        currentUserId="u1"
        members={members}
        teams={teams}
        canWork
        onAction={async () => true}
        onJump={noop}
      />,
    )
    expect(html).toContain('data-mention-banner="yes"')
    expect(html).toContain(m.markDone)
    expect(html).toContain(m.jumpToComment)
    expect(html).toContain('Support Team')
    expect(html).toContain(m.nudge)
    expect(html).toContain(m.cancelRequest)
    expect(html).toContain('Bo Chen')
  })

  it('the banner leaves out Nudge and Cancel without tickets.work, and renders nothing when there is nothing', () => {
    const readOnly = render(
      locale,
      <TicketMentionBanner
        requests={[request({ mentioned_user_id: 'u2', requested_by: 'u1' })]}
        currentUserId="u1"
        members={members}
        teams={teams}
        canWork={false}
        onAction={async () => true}
        onJump={noop}
      />,
    )
    expect(readOnly).not.toContain(m.nudge)
    expect(readOnly).not.toContain(m.cancelRequest)

    const none = render(
      locale,
      <TicketMentionBanner
        requests={[request({ status: 'done', resolved_reason: 'replied', resolved_at: 'x' }), request({ id: 'm9', mentioned_user_id: 'u9', requested_by: 'u8' })]}
        currentUserId="u1"
        members={members}
        teams={teams}
        canWork
        onAction={async () => true}
        onJump={noop}
      />,
    )
    expect(none).toBe('')
  })

  it('a comment draws its @person and @team chips, who it waits on, and the new history lines', () => {
    const comment: TicketComment = {
      id: 'c1',
      ticket_id: 'id-12',
      account_id: 'a',
      author_id: 'u2',
      body: 'Ada Lovelace, and @Support Team: please check @Ada Lovelace',
      mentions: ['u1'],
      mention_teams: ['t1'],
      created_at: '2026-09-19T00:00:00Z',
    }
    const ev = (id: string, event_type: TicketActivity['event_type'], over: Partial<TicketActivity> = {}): TicketActivity => ({
      id,
      ticket_id: 'id-12',
      account_id: 'a',
      actor_id: 'u2',
      event_type,
      created_at: '2026-09-19T00:00:00Z',
      ...over,
    })
    const html = render(
      locale,
      <TicketActivitySection
        comments={[comment]}
        activity={[
          ev('e1', 'mention_requested', { to_value: 'u1', detail: 'c1' }),
          ev('e2', 'mention_requested', { from_value: 't1', detail: 'c1' }),
          ev('e3', 'mention_done', { actor_id: 'u1', from_value: 'replied', to_value: 'u1' }),
          ev('e4', 'mention_done', { actor_id: 'u1', from_value: 'marked_done', to_value: 'u1' }),
          ev('e5', 'mention_done', { from_value: 'ticket_closed', detail: '3' }),
          ev('e6', 'mention_cancelled', { from_value: 'cancelled', to_value: 'u1' }),
          ev('e7', 'mention_cancelled', { from_value: 'comment_deleted', detail: '2' }),
        ]}
        members={members}
        teams={teams}
        fieldDefs={[]}
        linked={{}}
        keyOf={keyOf}
        canWork
        currentUserId="u2"
        onAddComment={async () => true}
        onEditComment={async () => true}
        onDeleteComment={async () => true}
        openRequests={[request({ mentioned_user_id: 'u1' })]}
        teamOptions={[{ id: 't1', name: 'Support Team', memberCount: 4 }]}
      />,
    )
    expect(html).toContain('id="comment-c1"')
    expect(html).toContain('data-mention="team"')
    expect(html).toContain('data-mention="person"')
    expect(html).toContain('data-waiting-on="yes"')
    expect(html).toContain('>@Support Team<')
    // the history lines: one per event, with real text (no raw keys)
    expect(html).not.toContain('mention_requested')
    expect(html).not.toContain('Tickets.detail.activity')
  })
})
