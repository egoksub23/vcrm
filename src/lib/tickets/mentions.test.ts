import { describe, expect, it } from 'vitest'

import {
  defaultsToResponse,
  mentionTokensFor,
  oldestOpenByTicket,
  planMentions,
  segmentBody,
  waitingTicketCount,
} from './mentions'

const set = (...ids: string[]) => new Set(ids)

const base = {
  authorId: 'author',
  personIds: [] as string[],
  teamIds: [] as string[],
  accountMemberIds: set('author', 'ada', 'bo', 'cy', 'di', 'ex'),
  teamMembers: new Map<string, string[]>([
    ['support', ['ada', 'bo', 'author', 'cy']],
    ['sales', ['bo', 'di']],
    ['empty', []],
  ]),
  canSeeTickets: set('author', 'ada', 'bo', 'cy', 'di'),
}

const ids = (plan: ReturnType<typeof planMentions>) => plan.recipients.map((r) => r.userId).sort()

describe('planMentions', () => {
  it('a person mention reaches that person directly', () => {
    const plan = planMentions({ ...base, personIds: ['ada'] })
    expect(plan.recipients).toEqual([{ userId: 'ada', viaTeamId: null }])
  })

  it('a team expands to all its members, without the author, marked with the team', () => {
    const plan = planMentions({ ...base, teamIds: ['support'] })
    expect(ids(plan)).toEqual(['ada', 'bo', 'cy'])
    expect(plan.recipients.every((r) => r.viaTeamId === 'support')).toBe(true)
  })

  it('someone named directly and through a team counts once, as a direct mention', () => {
    const plan = planMentions({ ...base, personIds: ['bo'], teamIds: ['support'] })
    expect(ids(plan)).toEqual(['ada', 'bo', 'cy'])
    expect(plan.recipients.find((r) => r.userId === 'bo')?.viaTeamId).toBeNull()
    expect(plan.recipients.find((r) => r.userId === 'ada')?.viaTeamId).toBe('support')
  })

  it('a member in two mentioned teams is asked once, through the first team', () => {
    const plan = planMentions({ ...base, teamIds: ['support', 'sales'] })
    expect(ids(plan)).toEqual(['ada', 'bo', 'cy', 'di'])
    expect(plan.recipients.find((r) => r.userId === 'bo')?.viaTeamId).toBe('support')
    expect(plan.recipients.find((r) => r.userId === 'di')?.viaTeamId).toBe('sales')
  })

  it('never reaches the author, even when named', () => {
    expect(ids(planMentions({ ...base, personIds: ['author', 'ada'] }))).toEqual(['ada'])
  })

  it('skips members whose role cannot open tickets and counts them', () => {
    const plan = planMentions({
      ...base,
      personIds: ['ex'],
      teamIds: ['support'],
      canSeeTickets: set('author', 'ada'),
    })
    expect(ids(plan)).toEqual(['ada'])
    expect(plan.skippedNoAccess.sort()).toEqual(['bo', 'cy', 'ex'])
  })

  it('drops people who are not in the account', () => {
    expect(ids(planMentions({ ...base, personIds: ['stranger', 'ada'] }))).toEqual(['ada'])
  })

  it('reports teams it does not know and expands empty ones to nobody', () => {
    const plan = planMentions({ ...base, teamIds: ['ghost', 'empty'] })
    expect(plan.unknownTeams).toEqual(['ghost'])
    expect(plan.recipients).toEqual([])
  })

  it('a team member who left the account is not asked', () => {
    const plan = planMentions({
      ...base,
      accountMemberIds: set('author', 'ada'),
      teamIds: ['support'],
    })
    expect(ids(plan)).toEqual(['ada'])
  })
})

describe('defaultsToResponse', () => {
  it('is on once the comment names anyone', () => {
    expect(defaultsToResponse(0)).toBe(false)
    expect(defaultsToResponse(1)).toBe(true)
  })
})

describe('segmentBody', () => {
  const tokens = [
    { name: 'Ann Lee', kind: 'person' as const },
    { name: 'Ann', kind: 'person' as const },
    { name: 'Support Team', kind: 'team' as const },
  ]

  it('draws people and teams as chips and keeps the text around them', () => {
    expect(segmentBody('Hi @Ann Lee and @Support Team, please look', tokens)).toEqual([
      { kind: 'text', text: 'Hi ' },
      { kind: 'person', text: '@Ann Lee' },
      { kind: 'text', text: ' and ' },
      { kind: 'team', text: '@Support Team' },
      { kind: 'text', text: ', please look' },
    ])
  })

  it('prefers the longest name, and does not cut a longer name short', () => {
    expect(segmentBody('@Ann Lee', tokens)).toEqual([{ kind: 'person', text: '@Ann Lee' }])
    expect(segmentBody('@Anna is not @Ann', tokens)).toEqual([
      { kind: 'text', text: '@Anna is not ' },
      { kind: 'person', text: '@Ann' },
    ])
  })

  it('leaves an email address and an unknown @name alone', () => {
    const body = 'mail me at joe@Ann.com or ask @Nobody'
    expect(segmentBody(body, tokens)).toEqual([{ kind: 'text', text: body }])
  })

  it('is plain text when there is nobody to draw', () => {
    expect(segmentBody('@Ann', [])).toEqual([{ kind: 'text', text: '@Ann' }])
    expect(segmentBody('no mentions', tokens)).toEqual([{ kind: 'text', text: 'no mentions' }])
  })
})

describe('mentionTokensFor', () => {
  it('turns a comment mentions and mention_teams into named tokens, skipping unknown ids', () => {
    const tokens = mentionTokensFor(
      { mentions: ['u1', 'gone'], mention_teams: ['t1'] },
      (id) => ({ u1: 'Ada' })[id as 'u1'] ?? null,
      (id) => ({ t1: 'Support' })[id as 't1'] ?? null,
    )
    expect(tokens).toEqual([
      { name: 'Ada', kind: 'person' },
      { name: 'Support', kind: 'team' },
    ])
  })

  it('copes with a comment written before migration 095', () => {
    expect(mentionTokensFor({ mentions: [] }, () => null, () => null)).toEqual([])
  })
})

describe('the numbers behind the bubble', () => {
  const row = (ticket_id: string, over: Record<string, unknown> = {}) => ({
    ticket_id,
    kind: 'response' as const,
    status: 'open' as const,
    created_at: '2026-09-20T10:00:00Z',
    ...over,
  })

  it('counts distinct tickets with an open response request', () => {
    expect(waitingTicketCount([row('a'), row('a'), row('b')])).toBe(2)
  })

  it('does not count done, cancelled or FYI requests', () => {
    expect(
      waitingTicketCount([
        row('a', { status: 'done' }),
        row('b', { status: 'cancelled' }),
        row('c', { kind: 'fyi' }),
      ]),
    ).toBe(0)
  })

  it('is zero with no rows', () => {
    expect(waitingTicketCount([])).toBe(0)
  })

  it('shows the longest-waiting request on each ticket', () => {
    const map = oldestOpenByTicket([
      row('a', { created_at: '2026-09-20T12:00:00Z', id: 'late' }),
      row('a', { created_at: '2026-09-20T08:00:00Z', id: 'early' }),
      row('b', { status: 'done', id: 'x' }),
    ])
    expect(map.size).toBe(1)
    expect((map.get('a') as unknown as { id: string }).id).toBe('early')
  })
})
