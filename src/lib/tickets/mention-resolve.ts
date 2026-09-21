import type { SupabaseClient } from '@supabase/supabase-js'

import { TicketCommentError } from './comment-write'
import type { TicketMention } from '@/types'

// ============================================================
// Mark as done / Cancel request / Nudge on a "needs a response" mention
// (migration 095). The rules live here so the route stays thin and the tests
// need no server:
//   done    only the person asked; the request must still be open
//   cancel  only the person who asked; the request must still be open
//   nudge   only the person who asked; at most once an hour per request
// The row is read as the caller (RLS: a stranger's row is "not found") and
// written with the service role: the table has no client write policy.
// ============================================================

export type MentionAction = 'done' | 'cancel' | 'nudge'

export const MENTION_ACTIONS: readonly MentionAction[] = ['done', 'cancel', 'nudge']

/** A nudge can be repeated after this long. */
export const NUDGE_COOLDOWN_MS = 60 * 60 * 1000

export function isMentionAction(v: unknown): v is MentionAction {
  return typeof v === 'string' && (MENTION_ACTIONS as readonly string[]).includes(v)
}

export interface ResolveInput {
  ticketId: string
  mentionId: string
  userId: string
  action: MentionAction
  now?: Date
}

/** How long ago the last nudge was, when it is too soon to send another. */
export function nudgeWaitMs(nudgedAt: string | null, now: Date): number {
  if (!nudgedAt) return 0
  const wait = new Date(nudgedAt).getTime() + NUDGE_COOLDOWN_MS - now.getTime()
  return wait > 0 ? wait : 0
}

export async function resolveMention(
  userDb: SupabaseClient,
  admin: SupabaseClient,
  input: ResolveInput,
): Promise<TicketMention> {
  const now = input.now ?? new Date()

  const { data, error } = await userDb
    .from('ticket_mentions')
    .select('*')
    .eq('id', input.mentionId)
    .eq('ticket_id', input.ticketId)
    .maybeSingle()
  if (error) {
    console.error('[resolveMention] read failed:', error)
    throw new TicketCommentError('Could not load the request.', 500)
  }
  const row = data as TicketMention | null
  if (!row) throw new TicketCommentError('Request not found.', 404)

  const isAsked = row.mentioned_user_id === input.userId
  const isAsker = row.requested_by === input.userId

  if (input.action === 'done') {
    if (!isAsked) throw new TicketCommentError('Only the person asked can mark this as done.', 403)
    // Clicking twice (or after replying) is not an error.
    if (row.status === 'done') return row
  } else if (!isAsker) {
    throw new TicketCommentError('Only the person who asked can do that.', 403)
  }
  if (row.status !== 'open') {
    throw new TicketCommentError('This request is already closed.', 409)
  }

  if (input.action === 'nudge') {
    const wait = nudgeWaitMs(row.nudged_at, now)
    if (wait > 0) {
      throw new TicketCommentError('You nudged them recently. Try again in a little while.', 429)
    }
    const [ticket, asker] = await Promise.all([
      admin.from('tickets').select('account_id, ticket_number, subject, contact_id').eq('id', row.ticket_id).maybeSingle(),
      admin.from('profiles').select('full_name').eq('user_id', input.userId).maybeSingle(),
    ])
    const t = ticket.data as { account_id: string; ticket_number: number; subject: string; contact_id: string | null } | null
    if (!t) throw new TicketCommentError('Ticket not found.', 404)

    // Claim the nudge first, so two quick clicks send one reminder.
    const claim = await admin
      .from('ticket_mentions')
      .update({ nudged_at: now.toISOString() })
      .eq('id', row.id)
      .eq('status', 'open')
      .or(`nudged_at.is.null,nudged_at.lt.${new Date(now.getTime() - NUDGE_COOLDOWN_MS).toISOString()}`)
      .select('*')
      .maybeSingle()
    if (claim.error) {
      console.error('[resolveMention] nudge claim failed:', claim.error)
      throw new TicketCommentError('Could not send the reminder.', 500)
    }
    if (!claim.data) throw new TicketCommentError('You nudged them recently. Try again in a little while.', 429)

    const name = (asker.data as { full_name: string | null } | null)?.full_name?.trim() || 'Someone'
    const note = await admin.from('notifications').insert({
      account_id: t.account_id,
      user_id: row.mentioned_user_id,
      type: 'ticket_mention',
      ticket_id: row.ticket_id,
      comment_id: row.comment_id,
      contact_id: t.contact_id,
      actor_user_id: input.userId,
      title: 'Your response is still needed',
      body: `${name} is waiting for your response on ticket #${t.ticket_number} — ${t.subject}`,
    })
    if (note.error) console.error('[resolveMention] nudge notification failed:', note.error)
    return claim.data as TicketMention
  }

  const reason = input.action === 'done' ? 'marked_done' : 'cancelled'
  const { data: updated, error: updateErr } = await admin
    .from('ticket_mentions')
    .update({
      status: input.action === 'done' ? 'done' : 'cancelled',
      resolved_at: now.toISOString(),
      resolved_by: input.userId,
      resolved_reason: reason,
    })
    .eq('id', row.id)
    .eq('status', 'open')
    .select('*')
    .maybeSingle()
  if (updateErr) {
    console.error('[resolveMention] update failed:', updateErr)
    throw new TicketCommentError('Could not update the request.', 500)
  }
  // Someone else closed it between the read and the write.
  if (!updated) throw new TicketCommentError('This request is already closed.', 409)
  return updated as TicketMention
}
