import type { SupabaseClient } from '@supabase/supabase-js'

import { loadCapabilityRecipients } from '@/lib/auth/capability-recipients'
import { isDoneStatus } from './constants'
import { planMentions, type MentionKind } from './mentions'
import type { TicketComment, TicketStatus } from '@/types'

// ============================================================
// Posting a ticket comment with @mentions of people and teams (migration 095).
// Server-side: the comment is written as the caller (RLS and the capability
// check apply, the mention notification trigger sees who wrote it); the
// follow-ups that a member cannot do for someone else (watchers, "needs a
// response" rows) are written with the service role.
// ============================================================

export const MAX_COMMENT_LENGTH = 10000

export class TicketCommentError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 429 | 500,
  ) {
    super(message)
    this.name = 'TicketCommentError'
  }
}

export interface PostCommentInput {
  accountId: string
  userId: string
  ticketId: string
  body: string
  /** People picked from the @ list. */
  mentions: readonly string[]
  /** Teams picked from the @ list. */
  teams: readonly string[]
  /** 'response': each person reached is asked to respond. 'fyi': they are only told. */
  kind: MentionKind
}

export interface PostCommentResult {
  comment: TicketComment
  /** People the mention reached (after expanding teams). */
  reached: number
  /** Members left out because their role cannot open tickets. */
  skippedNoAccess: number
  /** "Needs a response" requests created. */
  requestsCreated: number
  /** Something after the comment did not go through (the comment itself did). */
  warnings: ('watchers_failed' | 'requests_failed' | 'ticket_closed')[]
}

const asIds = (v: readonly unknown[]): string[] =>
  [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0))]

/**
 * Validate, expand the mentions, write the comment, then the watchers and the
 * requests. `userDb` is the caller's client; `admin` the service role.
 */
export async function postTicketComment(
  userDb: SupabaseClient,
  admin: SupabaseClient,
  input: PostCommentInput,
): Promise<PostCommentResult> {
  const text = input.body.trim()
  if (!text) throw new TicketCommentError('Write something first.', 400)
  if (text.length > MAX_COMMENT_LENGTH) {
    throw new TicketCommentError(`A comment can be up to ${MAX_COMMENT_LENGTH} characters.`, 400)
  }

  const { data: ticket, error: ticketErr } = await userDb
    .from('tickets')
    .select('id, account_id, status')
    .eq('id', input.ticketId)
    .maybeSingle()
  if (ticketErr) {
    console.error('[postTicketComment] ticket read failed:', ticketErr)
    throw new TicketCommentError('Could not load the ticket.', 500)
  }
  if (!ticket || ticket.account_id !== input.accountId) {
    throw new TicketCommentError('Ticket not found.', 404)
  }

  const personIds = asIds(input.mentions)
  const teamIds = asIds(input.teams)

  // ---- Who does this reach? ----------------------------------------------------
  let recipients: { userId: string; viaTeamId: string | null }[] = []
  let skippedNoAccess = 0
  let validTeamIds: string[] = []
  if (personIds.length > 0 || teamIds.length > 0) {
    const [members, teams] = await Promise.all([
      admin.from('profiles').select('user_id').eq('account_id', input.accountId),
      teamIds.length > 0
        ? admin.from('teams').select('id').eq('account_id', input.accountId).in('id', teamIds)
        : Promise.resolve({ data: [] as { id: string }[], error: null }),
    ])
    if (members.error || teams.error) {
      console.error('[postTicketComment] roster read failed:', members.error ?? teams.error)
      throw new TicketCommentError('Could not look up the people you mentioned.', 500)
    }
    validTeamIds = ((teams.data ?? []) as { id: string }[]).map((t) => t.id)

    const teamMembers = new Map<string, string[]>(validTeamIds.map((id) => [id, []]))
    if (validTeamIds.length > 0) {
      const { data, error } = await admin.from('team_members').select('team_id, user_id').in('team_id', validTeamIds)
      if (error) {
        console.error('[postTicketComment] team members read failed:', error)
        throw new TicketCommentError('Could not look up the team you mentioned.', 500)
      }
      for (const row of (data ?? []) as { team_id: string; user_id: string }[]) {
        teamMembers.get(row.team_id)?.push(row.user_id)
      }
    }

    const seers = await loadCapabilityRecipients(admin, input.accountId, 'menu.tickets')
    const plan = planMentions({
      authorId: input.userId,
      personIds,
      teamIds: validTeamIds,
      accountMemberIds: new Set(((members.data ?? []) as { user_id: string }[]).map((m) => m.user_id)),
      teamMembers,
      canSeeTickets: new Set(seers),
    })
    recipients = plan.recipients
    skippedNoAccess = plan.skippedNoAccess.length
  }

  // ---- The comment (as the caller) -----------------------------------------------
  const { data: comment, error: commentErr } = await userDb
    .from('ticket_comments')
    .insert({
      ticket_id: input.ticketId,
      account_id: input.accountId,
      author_id: input.userId,
      body: text,
      mentions: recipients.map((r) => r.userId),
      mention_teams: validTeamIds,
    })
    .select('*')
    .single()
  if (commentErr || !comment) {
    // 42501 / PGRST301: the capability policy said no.
    const denied = commentErr?.code === '42501'
    if (!denied) console.error('[postTicketComment] insert failed:', commentErr)
    throw new TicketCommentError(denied ? 'You cannot comment on tickets.' : 'Could not save the comment.', denied ? 403 : 500)
  }

  const warnings: PostCommentResult['warnings'] = []

  // ---- The people reached follow the ticket, so they can act on it -----------------
  if (recipients.length > 0) {
    const { error } = await admin.from('ticket_watchers').upsert(
      recipients.map((r) => ({ ticket_id: input.ticketId, user_id: r.userId, account_id: input.accountId })),
      { onConflict: 'ticket_id,user_id', ignoreDuplicates: true },
    )
    if (error) {
      console.error('[postTicketComment] watchers failed:', error)
      warnings.push('watchers_failed')
    }
  }

  // ---- "Needs a response" -----------------------------------------------------------
  let requestsCreated = 0
  if (input.kind === 'response' && recipients.length > 0) {
    if (isDoneStatus(ticket.status as TicketStatus)) {
      // Nothing would ever close these: the ticket is already done.
      warnings.push('ticket_closed')
    } else {
      const { error } = await admin.from('ticket_mentions').insert(
        recipients.map((r) => ({
          account_id: input.accountId,
          ticket_id: input.ticketId,
          comment_id: (comment as { id: string }).id,
          mentioned_user_id: r.userId,
          requested_by: input.userId,
          via_team_id: r.viaTeamId,
          kind: 'response',
        })),
      )
      if (error) {
        console.error('[postTicketComment] requests failed:', error)
        warnings.push('requests_failed')
      } else {
        requestsCreated = recipients.length
      }
    }
  }

  return {
    comment: comment as TicketComment,
    reached: recipients.length,
    skippedNoAccess,
    requestsCreated,
    warnings,
  }
}
