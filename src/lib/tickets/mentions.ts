import type { TicketComment, TicketMention } from '@/types'

// ============================================================
// Ticket @mentions of people and teams (migration 095). Pure helpers, no I/O:
// who a comment really reaches, how a comment body is drawn with its mention
// chips, and the numbers behind the sidebar bubble / "Mentioned me" filter.
// ============================================================

export type MentionKind = 'response' | 'fyi'

export interface MentionRecipient {
  userId: string
  /** The team it came through; null when the person was @mentioned directly. */
  viaTeamId: string | null
}

export interface MentionPlan {
  /** Everyone the comment reaches (the author never). */
  recipients: MentionRecipient[]
  /** Members left out because their role cannot open tickets. */
  skippedNoAccess: string[]
  /** Team ids that do not exist in this account (dropped). */
  unknownTeams: string[]
}

export interface MentionPlanInput {
  authorId: string
  /** People picked in the @ list (user ids). */
  personIds: readonly string[]
  /** Teams picked in the @ list. */
  teamIds: readonly string[]
  /** Everyone in the account: ids that are not in it are dropped. */
  accountMemberIds: ReadonlySet<string>
  /** Active members of each team, as they are right now (the snapshot). */
  teamMembers: ReadonlyMap<string, readonly string[]>
  /** Members whose role can open the Tickets page (menu.tickets). */
  canSeeTickets: ReadonlySet<string>
}

/**
 * Who a comment's mentions expand to. Teams expand to all their members at
 * post time; the author is never a recipient; someone named directly AND
 * through a team counts once, as a direct mention; a member who cannot open
 * tickets is skipped (and counted so the author is told).
 */
export function planMentions(input: MentionPlanInput): MentionPlan {
  const direct = new Set<string>()
  for (const id of input.personIds) {
    if (id && id !== input.authorId && input.accountMemberIds.has(id)) direct.add(id)
  }

  const via = new Map<string, string>()
  const unknownTeams: string[] = []
  for (const teamId of new Set(input.teamIds)) {
    const members = input.teamMembers.get(teamId)
    if (!members) {
      unknownTeams.push(teamId)
      continue
    }
    for (const id of members) {
      if (id === input.authorId || !input.accountMemberIds.has(id) || direct.has(id) || via.has(id)) continue
      via.set(id, teamId)
    }
  }

  const recipients: MentionRecipient[] = []
  const skippedNoAccess: string[] = []
  const consider = (userId: string, viaTeamId: string | null) => {
    if (input.canSeeTickets.has(userId)) recipients.push({ userId, viaTeamId })
    else skippedNoAccess.push(userId)
  }
  for (const id of direct) consider(id, null)
  for (const [id, teamId] of via) consider(id, teamId)
  return { recipients, skippedNoAccess, unknownTeams }
}

/** Whether a comment's "Needs a response" toggle starts on: yes once it names anyone. */
export function defaultsToResponse(mentionCount: number): boolean {
  return mentionCount > 0
}

// ---- Drawing a comment ---------------------------------------------------------

export type BodySegment =
  | { kind: 'text'; text: string }
  | { kind: 'person' | 'team'; text: string }

export interface MentionToken {
  name: string
  kind: 'person' | 'team'
}

/**
 * A comment body cut into plain text and mention chips. `tokens` are the
 * people and teams the comment names; `@Name` is matched case-sensitively,
 * the longest name first (so "@Ann Lee" wins over "@Ann"), and only when the
 * name is not followed by a letter or digit (so "@Anna" is not "@Ann" + "a").
 */
export function segmentBody(body: string, tokens: readonly MentionToken[]): BodySegment[] {
  const usable = [...tokens].filter((t) => t.name.trim() !== '').sort((a, b) => b.name.length - a.name.length)
  if (usable.length === 0 || !body.includes('@')) return [{ kind: 'text', text: body }]

  const out: BodySegment[] = []
  let text = ''
  let i = 0
  while (i < body.length) {
    if (body[i] === '@' && (i === 0 || /\s/.test(body[i - 1]))) {
      const hit = usable.find((t) => {
        if (!body.startsWith(t.name, i + 1)) return false
        const next = body[i + 1 + t.name.length]
        return next === undefined || !/[\p{L}\p{N}_]/u.test(next)
      })
      if (hit) {
        if (text) out.push({ kind: 'text', text })
        text = ''
        out.push({ kind: hit.kind, text: `@${hit.name}` })
        i += 1 + hit.name.length
        continue
      }
    }
    text += body[i]
    i += 1
  }
  if (text) out.push({ kind: 'text', text })
  return out
}

/** The chips a saved comment shows: the people in `mentions` and the teams in `mention_teams`. */
export function mentionTokensFor(
  comment: Pick<TicketComment, 'mentions' | 'mention_teams'>,
  nameOfUser: (id: string) => string | null,
  nameOfTeam: (id: string) => string | null,
): MentionToken[] {
  const tokens: MentionToken[] = []
  for (const id of comment.mentions ?? []) {
    const name = nameOfUser(id)
    if (name) tokens.push({ name, kind: 'person' })
  }
  for (const id of comment.mention_teams ?? []) {
    const name = nameOfTeam(id)
    if (name) tokens.push({ name, kind: 'team' })
  }
  return tokens
}

// ---- The bubble and the "Waiting on you" chips -----------------------------------

type OpenLike = Pick<TicketMention, 'ticket_id' | 'kind' | 'status'>

/** Requests that still need the person's answer. */
export function openResponses<T extends OpenLike>(rows: readonly T[]): T[] {
  return rows.filter((r) => r.kind === 'response' && r.status === 'open')
}

/** Distinct tickets waiting on the person: what the sidebar bubble counts. */
export function waitingTicketCount(rows: readonly OpenLike[]): number {
  return new Set(openResponses(rows).map((r) => r.ticket_id)).size
}

/**
 * The request each ticket shows on its card / row: the oldest open one (the
 * longest wait), keyed by ticket id.
 */
export function oldestOpenByTicket<T extends OpenLike & Pick<TicketMention, 'created_at'>>(
  rows: readonly T[],
): Map<string, T> {
  const out = new Map<string, T>()
  for (const r of openResponses(rows)) {
    const known = out.get(r.ticket_id)
    if (!known || r.created_at < known.created_at) out.set(r.ticket_id, r)
  }
  return out
}
