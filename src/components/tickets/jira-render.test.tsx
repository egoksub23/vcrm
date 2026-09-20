import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { beforeAll, describe, expect, it } from 'vitest'

import type { TicketJira } from '@/hooks/use-ticket-jira'
import type { TicketRow } from '@/hooks/use-ticket-store'
import type { TicketJiraLinkRow } from '@/lib/jira/types'
import type { JiraChip } from '@/lib/tickets/jira-ui'
import { DEFAULT_SORT } from '@/lib/tickets/sort-group'
import type { Profile, Team, TicketComment } from '@/types'
import { JiraCreateForm, EMPTY_CREATE_CHOICES, type JiraCreateFormProps } from './jira-create-dialog'
import { JiraKeyChip, JiraKeyChips } from './jira-key-chip'
import { JiraLinkForm, type JiraLinkFormProps } from './jira-link-dialog'
import { TicketActivitySection } from './ticket-activity'
import { TicketBoard } from './ticket-board'
import { TicketJiraCard, type TicketJiraCardProps } from './ticket-jira-card'
import { TicketJiraSection } from './ticket-jira-section'
import { TicketListView } from './ticket-list-view'
import { StatusLozenge } from './ticket-visuals'

// Render smoke tests for the ticket side of the Jira link, in English and
// Korean with the real translations. next-intl errors (a missing key, a
// missing argument) are thrown, so a string that is not in the catalogue
// fails here instead of showing a raw key path.

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

const noop = () => {}
// renderToStaticMarkup escapes < > & in text
const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const ok = async () => ({ ok: true as const, status: 200, data: {} as never })
const NOW = new Date('2026-09-20T12:00:00Z')

const link = (over: Partial<TicketJiraLinkRow> = {}): TicketJiraLinkRow => ({
  id: 'l1',
  account_id: 'a',
  ticket_id: 'id-12',
  connection_id: 'c1',
  issue_id: '10001',
  issue_key: 'ENG-482',
  project_key: 'ENG',
  project_name: 'Engineering',
  issue_type: 'Bug',
  summary: 'Checkout fails on Safari',
  status_id: '3',
  status_name: 'In Progress',
  status_category: 'indeterminate',
  resolution: null,
  priority_name: 'High',
  assignee_account_id: 'acc1',
  assignee_name: 'Priya Nair',
  reporter_name: 'Sam Ortiz',
  issue_url: 'https://acme.atlassian.net/browse/ENG-482',
  jira_updated_at: '2026-09-20T11:00:00Z',
  last_synced_at: '2026-09-20T11:57:00Z',
  sync_state: 'ok',
  sync_error: null,
  last_written: {},
  last_push: null,
  remote_link_id: null,
  linked_by: 'u1',
  last_resync_at: null,
  created_at: '2026-09-20T10:00:00Z',
  updated_at: '2026-09-20T11:57:00Z',
  ...over,
})

const cardProps = (over: Partial<TicketJiraCardProps> = {}): TicketJiraCardProps => ({
  link: link(),
  canLink: true,
  canShare: true,
  canConnect: false,
  needsReconnect: false,
  now: NOW,
  onSync: ok,
  onUnlink: ok,
  onLoadTransitions: async () => ({ ok: true, status: 200, data: { transitions: [] } }),
  onTransition: ok,
  onComment: async () => ({ ok: true, status: 201, data: { noteId: 'n1', results: [] } }),
  ...over,
})

const members = [
  { id: 'p1', user_id: 'u1', full_name: 'Ada Lovelace', email: 'a@x.test', role: 'agent' },
  { id: 'p2', user_id: 'u2', full_name: 'Bo Chen', email: 'b@x.test', role: 'agent' },
] as Profile[]
const teams = [] as Team[]
type ActivityProps = React.ComponentProps<typeof TicketActivitySection>

describe.each(['en', 'ko'])('Jira ticket surfaces render with %s messages', (locale) => {
  const m = () => load(locale)

  // The first useTranslations in a process renders without the provider's
  // context (next-intl loads it lazily); a throwaway render absorbs that.
  beforeAll(() => {
    try {
      render(locale, <StatusLozenge status="open" />)
    } catch {
      // only the warm-up may fail
    }
  })

  describe('TicketJiraCard', () => {
    it('a healthy issue: key and summary link out, status lozenge, people, actions', () => {
      const html = render(locale, <TicketJiraCard {...cardProps()} />)
      expect(html).toContain('ENG-482')
      expect(html).toContain('Checkout fails on Safari')
      expect(html).toContain('href="https://acme.atlassian.net/browse/ENG-482"')
      expect(html).toContain('target="_blank"')
      expect(html).toContain('rel="noopener noreferrer"')
      expect(html).toContain('In Progress')
      expect(html).toContain('text-blue-700')
      expect(html).toContain('Priya Nair')
      expect(html).toContain('Sam Ortiz')
      expect(html).toContain('Engineering')
      expect(html).toContain(m().Jira.card.sync)
      expect(html).toContain(m().Jira.card.move)
      expect(html).toContain(m().Jira.card.comment)
      expect(html).toContain(m().Jira.card.unlink)
      expect(html).not.toContain('data-banner')
    })

    it('done issues are green and show their resolution', () => {
      const html = render(locale, <TicketJiraCard {...cardProps({ link: link({ status_name: 'Done', status_category: 'done', resolution: 'Fixed' }) })} />)
      expect(html).toContain('text-emerald-700')
      expect(html).toContain('Fixed')
    })

    it('a paused link shows the reconnect banner: a settings link for admins, plain text otherwise', () => {
      const paused = link({ sync_state: 'paused' })
      const admin = render(locale, <TicketJiraCard {...cardProps({ link: paused, needsReconnect: true, canConnect: true })} />)
      expect(admin).toContain('data-banner="reconnect"')
      expect(admin).toContain('href="/settings?tab=integrations"')
      const agent = render(locale, <TicketJiraCard {...cardProps({ link: paused, needsReconnect: true })} />)
      expect(agent).toContain('data-banner="reconnect"')
      expect(agent).toContain(m().Jira.banner.reconnectAsk)
      expect(agent).not.toContain('/settings?tab=integrations')
      // paused for another reason: a generic banner, and no move / comment
      const generic = render(locale, <TicketJiraCard {...cardProps({ link: paused })} />)
      expect(generic).toContain('data-banner="paused"')
    })

    it('a broken link offers Unlink and explains how to relink', () => {
      const gone = render(locale, <TicketJiraCard {...cardProps({ link: link({ sync_state: 'broken', sync_error: 'not_found' }) })} />)
      expect(gone).toContain('data-banner="not_found"')
      expect(gone).toContain(m().Jira.banner.notFoundBody)
      expect(gone).toContain(m().Jira.card.unlink)
      const noAccess = render(locale, <TicketJiraCard {...cardProps({ link: link({ sync_state: 'broken', sync_error: 'no_access' }) })} />)
      expect(noAccess).toContain('data-banner="no_access"')
    })

    it('a failed status push explains why (no transition, screen fields, permission)', () => {
      for (const reason of ['no_transition', 'screen_fields', 'permission']) {
        const html = render(locale, <TicketJiraCard {...cardProps({ link: link({ last_push: { ok: false, reason, wanted: 'Done', at: '2026-09-20T11:00:00Z' } }) })} />)
        expect(html).toContain(`data-banner="${reason}"`)
      }
      // a push that worked, or was simply not needed, shows nothing
      const fine = render(locale, <TicketJiraCard {...cardProps({ link: link({ last_push: { ok: true, reason: 'moved', at: '2026-09-20T11:00:00Z' } }) })} />)
      expect(fine).not.toContain('data-banner')
      const notMapped = render(locale, <TicketJiraCard {...cardProps({ link: link({ last_push: { ok: false, reason: 'not_mapped', at: '2026-09-20T11:00:00Z' } }) })} />)
      expect(notMapped).not.toContain('data-banner')
    })

    it('viewers get no action buttons; agents without the share capability keep the others', () => {
      const viewer = render(locale, <TicketJiraCard {...cardProps({ canLink: false, canShare: false })} />)
      expect(viewer).toContain('ENG-482')
      expect(viewer).not.toContain('<button')
      const noShare = render(locale, <TicketJiraCard {...cardProps({ canShare: false })} />)
      expect(noShare).toContain(m().Jira.card.sync)
      expect(noShare).toContain(m().Jira.card.noCommentPermission)
    })

    it('an issue that was never synced and has no address renders as plain text', () => {
      const html = render(locale, <TicketJiraCard {...cardProps({ link: link({ issue_url: null, last_synced_at: null, resolution: null, assignee_name: null }) })} />)
      expect(html).toContain(m().Jira.card.neverSynced)
      expect(html).toContain(m().Jira.card.unassigned)
      expect(html).not.toContain('href="https://acme')
    })

    it('Jira text is escaped, never rendered as HTML', () => {
      const html = render(locale, <TicketJiraCard {...cardProps({ link: link({ summary: '<img src=x onerror=alert(1)>', issue_url: 'javascript:alert(1)' }) })} />)
      expect(html).not.toContain('<img src=x')
      expect(html).not.toContain('javascript:')
    })
  })

  describe('JiraCreateForm', () => {
    const base = (over: Partial<JiraCreateFormProps> = {}): JiraCreateFormProps => ({
      siteUrl: 'https://acme.atlassian.net',
      projects: [{ id: '1', key: 'ENG', name: 'Engineering' }],
      projectsLoading: false,
      issueTypes: [{ id: '10', name: 'Bug' }],
      issueTypesLoading: false,
      priorities: [{ id: '2', name: 'High' }],
      choices: { ...EMPTY_CREATE_CHOICES, projectKey: 'ENG', issueTypeId: '10' },
      onChoicesChange: noop,
      onSearchUsers: async () => [],
      preview: null,
      previewLoading: false,
      previewError: null,
      fieldValues: {},
      onFieldValuesChange: noop,
      creating: false,
      createError: null,
      onCreate: noop,
      onCancel: noop,
      ...over,
    })
    const preview = (over: Record<string, unknown> = {}, required: Record<string, unknown> = {}) => ({
      preview: {
        project: 'ENG',
        issueType: 'Bug',
        summary: 'Checkout fails on Safari',
        descriptionText: 'Customer cannot pay.\nSee the Vircle ticket.',
        descriptionTruncated: false,
        priority: 'High',
        labels: ['vircle', 'bug'],
        assigneeAccountId: null,
        includesCustomer: false,
        extraFields: {},
        ...over,
      },
      required: { ask: [], unsupported: [], ...required },
      previewRequired: true,
    })

    it('shows exactly what will be sent, and says the customer is left out', () => {
      const html = render(locale, <JiraCreateForm {...base({ preview: preview() as never })} />)
      expect(html).toContain('Checkout fails on Safari')
      expect(html).toContain('Customer cannot pay.')
      expect(html).toContain('vircle, bug')
      expect(html).toContain('data-includes-customer="no"')
      expect(html).toContain(m().Jira.create.customerExcluded)
      expect(html).toContain(m().Jira.create.create)
      expect(html).not.toContain('data-unsupported')
    })

    it('says so when the customer name and email are included', () => {
      const html = render(locale, <JiraCreateForm {...base({ preview: preview({ includesCustomer: true }) as never })} />)
      expect(html).toContain('data-includes-customer="yes"')
      expect(html).toContain(m().Jira.create.customerIncluded)
    })

    it('renders a control for every kind of required field and holds Create until they are filled', () => {
      const ask = [
        { id: 'customfield_1', name: 'Environment', kind: 'textarea', options: [] },
        { id: 'customfield_2', name: 'Story points', kind: 'number', options: [] },
        { id: 'customfield_3', name: 'Due', kind: 'date', options: [] },
        { id: 'customfield_4', name: 'Severity', kind: 'select', options: [{ id: 's1', name: 'Sev 1' }] },
        { id: 'customfield_5', name: 'Components', kind: 'multiselect', options: [{ id: 'c1', name: 'Web' }] },
        { id: 'customfield_6', name: 'Reviewer', kind: 'user', options: [] },
        { id: 'customfield_7', name: 'Extra labels', kind: 'labels', options: [] },
        { id: 'customfield_8', name: 'Team name', kind: 'text', options: [] },
      ]
      const empty = render(locale, <JiraCreateForm {...base({ preview: preview({}, { ask }) as never })} />)
      for (const f of ask) expect(empty).toContain(`${f.name} *`)
      expect(empty).toContain('type="number"')
      expect(empty).toContain('type="date"')
      expect(empty).toContain('Sev 1')
      expect(empty).toContain('type="checkbox"')
      expect(empty.slice(empty.lastIndexOf('<button'))).toContain('disabled=""')

      const values = Object.fromEntries(ask.map((f) => [f.id, f.kind === 'multiselect' ? ['c1'] : f.kind === 'select' ? 's1' : f.kind === 'number' ? '3' : 'x']))
      const filled = render(locale, <JiraCreateForm {...base({ preview: preview({}, { ask }) as never, fieldValues: values })} />)
      expect(filled.slice(filled.lastIndexOf('<button'))).not.toContain('disabled=""')
    })

    it('unsupported required fields: explains, links to Jira and disables Create', () => {
      const html = render(locale, <JiraCreateForm {...base({ preview: preview({}, { unsupported: ['Approver group', 'Cascading region'] }) as never })} />)
      expect(html).toContain('data-unsupported="yes"')
      expect(html).toContain(m().Jira.create.unsupportedTitle)
      expect(html).toContain('Approver group')
      expect(html).toContain('href="https://acme.atlassian.net/"')
      expect(html).toContain(m().Jira.create.openInJira)
      expect(html.slice(html.lastIndexOf('<button'))).toContain('disabled=""')
    })

    it('friendly errors: Jira rejected the issue, and the project limit', () => {
      const rejected = render(
        locale,
        <JiraCreateForm
          {...base({
            preview: preview() as never,
            createError: { ok: false, status: 422, code: 'jira_rejected', message: '', messages: ['Field x is bad'], fieldErrors: { summary: 'Too long' } },
          })}
        />,
      )
      expect(rejected).toContain(m().Jira.errors.jira_rejected)
      expect(rejected).toContain('Field x is bad')
      expect(rejected).toContain('summary: Too long')
      const limit = render(
        locale,
        <JiraCreateForm {...base({ createError: { ok: false, status: 409, code: 'link_limit', message: '' } })} />,
      )
      expect(limit).toContain(m().Jira.errors.link_limit)
      const denied = render(
        locale,
        <JiraCreateForm {...base({ previewError: { ok: false, status: 403, code: 'project_not_allowed', message: '' } })} />,
      )
      expect(denied).toContain(m().Jira.errors.project_not_allowed)
      const reauth = render(
        locale,
        <JiraCreateForm {...base({ projects: [], projectsError: { ok: false, status: 409, code: 'reauth_required', message: '' } })} />,
      )
      expect(reauth).toContain(esc(m().Jira.errors.reauth_required))
    })

    it('while the projects load and before a type is chosen it shows only the choices', () => {
      const html = render(locale, <JiraCreateForm {...base({ projects: [], projectsLoading: true, choices: EMPTY_CREATE_CHOICES })} />)
      expect(html).toContain(m().Jira.create.loading)
      expect(html).not.toContain(m().Jira.create.previewHeading)
    })
  })

  describe('JiraLinkForm', () => {
    const base = (over: Partial<JiraLinkFormProps> = {}): JiraLinkFormProps => ({
      query: 'checkout',
      onQueryChange: noop,
      results: [
        { id: '1', key: 'ENG-482', summary: 'Checkout fails on Safari', status: 'In Progress', category: 'indeterminate', project: 'ENG', type: 'Bug' },
        { id: '2', key: 'ENG-9', summary: 'Checkout redesign', status: 'Done', category: 'done', project: 'ENG', type: 'Story' },
      ],
      searching: false,
      searchError: null,
      linkedKeys: ['ENG-9'],
      selectedKey: null,
      onSelect: noop,
      linking: false,
      linkError: null,
      onLink: noop,
      onCancel: noop,
      ...over,
    })

    it('lists results, marks the ones already linked, and explains the rules', () => {
      const html = render(locale, <JiraLinkForm {...base()} />)
      expect(html).toContain('ENG-482')
      expect(html).toContain('Checkout redesign')
      expect(html).toContain(m().Jira.link.alreadyLinkedHere)
      expect(html).toContain(m().Jira.link.noteShared)
      expect(html).toContain(m().Jira.link.noteComments)
    })

    it('a picked result names the issue on the button', () => {
      const html = render(locale, <JiraLinkForm {...base({ selectedKey: 'ENG-482' })} />)
      expect(html).toContain('aria-pressed="true"')
      expect(html).toContain(m().Jira.link.linkKey.replace('{key}', 'ENG-482'))
    })

    it('a pasted URL is understood without a search', () => {
      const html = render(locale, <JiraLinkForm {...base({ query: 'https://acme.atlassian.net/browse/ENG-77', results: null })} />)
      expect(html).toContain(m().Jira.link.willLink.replace('{key}', 'ENG-77'))
      expect(html).toContain(m().Jira.link.linkKey.replace('{key}', 'ENG-77'))
    })

    it('empty, searching and error states', () => {
      expect(render(locale, <JiraLinkForm {...base({ results: [] })} />)).toContain(m().Jira.link.noResults)
      expect(render(locale, <JiraLinkForm {...base({ searching: true, results: null })} />)).toContain(m().Jira.link.searching)
      const failed = render(
        locale,
        <JiraLinkForm {...base({ linkError: { ok: false, status: 409, code: 'already_linked', message: '' } })} />,
      )
      expect(failed).toContain(m().Jira.errors.already_linked)
    })
  })

  describe('key chips', () => {
    const chip = (key: string, over: Partial<JiraChip> = {}): JiraChip => ({ key, category: 'indeterminate', url: null, state: 'ok', ...over })

    it('colours by category and marks broken and paused links', () => {
      const html = render(
        locale,
        <div>
          <JiraKeyChip chip={chip('ENG-1', { category: 'new' })} />
          <JiraKeyChip chip={chip('ENG-2', { category: 'done' })} />
          <JiraKeyChip chip={chip('ENG-3', { state: 'broken' })} />
          <JiraKeyChip chip={chip('ENG-4', { state: 'paused' })} />
        </div>,
      )
      expect(html).toContain('text-slate-700')
      expect(html).toContain('text-emerald-700')
      expect(html).toContain('line-through')
      expect(html).toContain('ENG-4')
    })

    it('shows at most two chips and then +N; nothing when there are none', () => {
      const html = render(locale, <JiraKeyChips chips={[chip('ENG-1'), chip('ENG-2'), chip('ENG-3'), chip('ENG-4')]} />)
      expect(html).toContain('ENG-1')
      expect(html).toContain('ENG-2')
      expect(html).not.toContain('ENG-3')
      expect(html).toContain('+2')
      expect(render(locale, <div><JiraKeyChips chips={[]} /></div>)).not.toContain('ENG')
      expect(render(locale, <div><JiraKeyChips chips={undefined} /></div>)).not.toContain('ENG')
    })

    it('appear on board cards and list rows only when given', () => {
      const row = (n: number): TicketRow => ({
        id: `id-${n}`,
        account_id: 'a',
        ticket_number: n,
        contact_id: 'c1',
        subject: `Subject ${n}`,
        category: 'bug',
        status: 'open',
        priority: 'normal',
        assigned_agent_id: null,
        assigned_team_id: null,
        created_by: 'u2',
        labels: [],
        due_date: null,
        board_rank: 100 - n,
        created_at: '2026-09-01T00:00:00Z',
        updated_at: '2026-09-19T00:00:00Z',
        contact: { id: 'c1', name: 'Grace Hopper', phone: '+100', wa_username: null, wa_user_id: null },
        comment_count: 0,
      })
      const rows = [row(1), row(2)]
      const chips = { 'id-1': [chip('ENG-482'), chip('OPS-3', { category: 'done' })] }
      const zero = { open: 2, in_progress: 0, pending: 0, resolved: 0, closed: 0 }
      const flags = { open: true, in_progress: true, pending: true, resolved: true, closed: false }
      const board = (jiraChips?: Record<string, JiraChip[]>) =>
        render(
          locale,
          <TicketBoard
            rows={rows}
            totals={zero}
            loadedCounts={zero}
            columnLoaded={flags}
            loadingMore={null}
            filtered={false}
            canWork
            keyOf={(n) => `VIR-${n}`}
            members={members}
            onOpen={noop}
            onMove={noop}
            onShowMore={noop}
            onExpandColumn={noop}
            closedOpen={false}
            onClosedOpenChange={noop}
            jiraChips={jiraChips}
          />,
        )
      expect(board(chips)).toContain('ENG-482')
      expect(board(chips)).toContain('OPS-3')
      expect(board()).not.toContain('ENG-482')

      const list = (jiraChips?: Record<string, JiraChip[]>) =>
        render(
          locale,
          <TicketListView
            rows={rows}
            sort={DEFAULT_SORT}
            onSortChange={noop}
            groupBy="none"
            selected={new Set()}
            onSelectedChange={noop}
            canWork
            keyOf={(n) => `VIR-${n}`}
            members={members}
            nameOf={() => ''}
            onOpen={noop}
            onPatch={noop}
            hasMore={false}
            loadingMore={false}
            onLoadMore={noop}
            jiraChips={jiraChips}
          />,
        )
      expect(list(chips)).toContain('ENG-482')
      expect(list()).not.toContain('ENG-482')
    })
  })

  describe('activity list', () => {
    const at = '2026-09-19T00:00:00Z'
    const props = (over: Partial<ActivityProps> = {}): ActivityProps => ({
      comments: [],
      activity: [],
      members,
      teams,
      fieldDefs: [],
      linked: {},
      keyOf: (n: number) => `VIR-${n}`,
      canWork: true,
      currentUserId: 'u1',
      onAddComment: async () => true,
      onEditComment: async () => true,
      onDeleteComment: async () => true,
      ...over,
    })
    const note = (over: Partial<TicketComment>): TicketComment => ({ id: 'n', ticket_id: 'id-12', account_id: 'a', body: 'text', mentions: [], created_at: at, ...over })

    it('a note from Jira shows a Jira tag, never a person, and has no Edit or Delete', () => {
      const html = render(
        locale,
        <TicketActivitySection
          {...props({
            comments: [note({ id: 'j1', source: 'jira', author_id: null, jira_author: 'Priya Nair', body: 'Fixed in 4.2 <b>now</b>' })],
          })}
        />,
      )
      expect(html).toContain('data-jira-note="yes"')
      expect(html).toContain(m().Tickets.detail.activity.jiraNoteTag.replace('{author}', 'Priya Nair'))
      expect(html).toContain('Fixed in 4.2 &lt;b&gt;now&lt;/b&gt;')
      expect(html).not.toContain(m().Tickets.common.unknownPerson)
      expect(html).not.toContain(`>${m().Tickets.detail.edit}<`)
      expect(html).not.toContain(m().Tickets.detail.activity.shareWithJira)
    })

    it('a note deleted in Jira keeps its text with a muted marker', () => {
      const html = render(
        locale,
        <TicketActivitySection
          {...props({
            comments: [note({ id: 'j2', source: 'jira', author_id: null, jira_author: 'Priya Nair', deleted_in_jira: true, body: 'Old text' })],
          })}
        />,
      )
      expect(html).toContain('Old text')
      expect(html).toContain(m().Tickets.detail.activity.jiraDeleted)
    })

    it('Share with Jira only appears when allowed, and a shared note says so instead', () => {
      const comments = [
        note({ id: 'v1', author_id: 'u2', body: 'Written in Vircle' }),
        note({ id: 'v2', author_id: 'u2', body: 'Already sent' }),
      ]
      const allowed = render(
        locale,
        <TicketActivitySection {...props({ comments, canShareToJira: true, jiraSharedNoteIds: new Set(['v2']), onShareToJira: async () => true })} />,
      )
      expect(allowed).toContain(m().Tickets.detail.activity.shareWithJira)
      expect(allowed).toContain(m().Tickets.detail.activity.sharedWithJira)
      // the shared one has no button of its own: exactly one Share button
      expect(allowed.split(`>${m().Tickets.detail.activity.shareWithJira}<`).length - 1).toBe(1)

      const denied = render(
        locale,
        <TicketActivitySection {...props({ comments, canShareToJira: false, jiraSharedNoteIds: new Set(['v2']) })} />,
      )
      expect(denied).not.toContain(`>${m().Tickets.detail.activity.shareWithJira}<`)
      expect(denied).toContain(m().Tickets.detail.activity.sharedWithJira)
    })

    it('the four Jira events read as sentences; a sync from Jira names no person', () => {
      const html = render(
        locale,
        <TicketActivitySection
          {...props({
            activity: [
              { id: 'e1', ticket_id: 'id-12', account_id: 'a', actor_id: 'u2', event_type: 'jira_linked', to_value: 'ENG-1', created_at: at },
              { id: 'e2', ticket_id: 'id-12', account_id: 'a', actor_id: 'u2', event_type: 'jira_unlinked', to_value: 'ENG-1', created_at: at },
              { id: 'e3', ticket_id: 'id-12', account_id: 'a', actor_id: null, event_type: 'jira_status_synced', from_value: 'pending', to_value: 'resolved', detail: 'ENG-1', created_at: at },
              { id: 'e4', ticket_id: 'id-12', account_id: 'a', actor_id: 'u2', event_type: 'jira_status_pushed', to_value: 'In Review', detail: 'ENG-1', created_at: at },
            ],
          })}
        />,
      )
      const a = m().Tickets.detail.activity
      expect(html).toContain(a.jiraLinked.replace('{key}', 'ENG-1'))
      expect(html).toContain(a.jiraUnlinked.replace('{key}', 'ENG-1'))
      expect(html).toContain(
        a.jiraStatusSynced.replace('{from}', m().Tickets.common.status.pending).replace('{to}', m().Tickets.common.status.resolved).replace('{key}', 'ENG-1'),
      )
      expect(html).toContain(a.jiraStatusPushed.replace('{key}', 'ENG-1').replace('{status}', 'In Review'))

      const synced = render(
        locale,
        <TicketActivitySection
          {...props({
            activity: [{ id: 'e5', ticket_id: 'id-12', account_id: 'a', actor_id: 'u1', event_type: 'jira_status_synced', from_value: 'open', to_value: 'closed', detail: 'ENG-2', created_at: at }],
          })}
        />,
      )
      // the comment box shows the current user's avatar; the event line itself names nobody
      expect(synced).not.toContain('font-medium text-foreground">Ada Lovelace')
    })

    it('without the new props the list renders as before (no Jira actions)', () => {
      const html = render(locale, <TicketActivitySection {...props({ comments: [note({ id: 'v3', author_id: 'u1', body: 'Mine' })] })} />)
      expect(html).toContain('Mine')
      expect(html).not.toContain(m().Tickets.detail.activity.shareWithJira)
    })
  })

  describe('TicketJiraSection', () => {
    const jira = (over: Partial<TicketJira> = {}): TicketJira => ({
      loading: false,
      links: [link(), link({ id: 'l2', issue_key: 'OPS-3', summary: 'Rotate keys' })],
      connection: {
        id: 'c1',
        status: 'active',
        statusReason: null,
        siteName: 'Acme',
        siteUrl: 'https://acme.atlassian.net',
        settings: { projects: { allowed: [], default_project: null, default_issue_type: null } } as never,
      },
      connected: true,
      needsReconnect: false,
      commentsToJira: true,
      hasOkLink: true,
      atLimit: false,
      sharedNoteIds: new Set(),
      attachmentsEnabled: false,
      sentAttachmentIds: new Set(),
      skippedFiles: [],
      sendAttachment: ok as never,
      reload: async () => {},
      syncNow: ok as never,
      unlink: ok as never,
      listTransitions: (async () => ({ ok: true, status: 200, data: { transitions: [] } })) as never,
      transition: ok as never,
      commentInJira: ok as never,
      shareNote: ok as never,
      ...over,
    })

    it('lists every link as a card under a Jira heading; viewers see no Create / Link buttons', () => {
      const html = render(locale, <TicketJiraSection ticketId="id-12" jira={jira()} />)
      expect(html).toContain(m().Jira.section.heading)
      expect(html).toContain('ENG-482')
      expect(html).toContain('OPS-3')
      expect(html).not.toContain(m().Jira.section.create)
      expect(html).not.toContain(m().Jira.section.link)
    })

    it('with nothing linked it shows a hint; without Jira it shows nothing', () => {
      const empty = render(locale, <TicketJiraSection ticketId="id-12" jira={jira({ links: [] })} />)
      expect(empty).toContain(m().Jira.section.empty)
      const off = render(locale, <div><TicketJiraSection ticketId="id-12" jira={jira({ links: [], connected: false, connection: null })} /></div>)
      expect(off).not.toContain(m().Jira.section.heading)
      const loading = render(locale, <div><TicketJiraSection ticketId="id-12" jira={jira({ loading: true })} /></div>)
      expect(loading).not.toContain('ENG-482')
    })
  })
})
