import type { SupabaseClient } from '@supabase/supabase-js'
import { performCommentAction, type ActionResult } from './actions'
import { BULK_CHUNK, type BulkOp, type BulkResult } from './threads'

// ============================================================
// One action on several comments of the Comments inbox (the group buttons and the bulk bar).
//
//   resolve / spam / reopen   the same handled-status change the single comment's buttons make (PATCH /api/comments/[id]), done through the
//                             caller's own session so row level security (comments.moderate) decides, one query for the lot
//   hide / unhide             performCommentAction(), the one place that talks to the provider, called once per comment
//
// Every comment gets its own answer. A comment that cannot be changed is reported, never dropped, and never stops the others.
// ============================================================

export const BULK_OPS: readonly BulkOp[] = ['resolve', 'spam', 'reopen', 'hide', 'unhide']
export const BULK_MAX_IDS = BULK_CHUNK

const STATUS_FOR: Record<'resolve' | 'spam' | 'reopen', 'resolved' | 'spam' | 'open'> = {
  resolve: 'resolved',
  spam: 'spam',
  reopen: 'open',
}

type Perform = (
  db: SupabaseClient,
  ctx: { accountId: string; userId: string },
  commentId: string,
  action: 'hide' | 'unhide',
) => Promise<ActionResult>

interface Row {
  id: string
  direction: 'inbound' | 'outbound'
  status: 'visible' | 'hidden' | 'deleted'
  handled_status: 'open' | 'replied' | 'resolved' | 'spam'
}

/** Does `op` change anything for a comment in this state? Mirrors the single-comment buttons: Mark handled only on an open comment, Reopen on a handled one. */
function wouldChange(op: 'resolve' | 'spam' | 'reopen', h: Row['handled_status']): boolean {
  if (op === 'resolve') return h === 'open'
  if (op === 'spam') return h !== 'spam'
  return h === 'resolved' || h === 'spam'
}

export async function runBulkOp(args: {
  /** The caller's own client (row level security applies). */
  userDb: SupabaseClient
  /** The service-role client the provider actions run with. */
  adminDb: SupabaseClient
  ctx: { accountId: string; userId: string }
  op: BulkOp
  ids: string[]
  perform?: Perform
}): Promise<BulkResult[]> {
  const { userDb, adminDb, ctx, op } = args
  const perform: Perform = args.perform ?? ((db, c, id, action) => performCommentAction(db, c, id, action))
  const ids = [...new Set(args.ids)]

  const { data, error } = await userDb
    .from('comments')
    .select('id, direction, status, handled_status')
    .eq('account_id', ctx.accountId)
    .in('id', ids)
  if (error) {
    console.error('[comments bulk] lookup failed:', error)
    return ids.map((id) => ({ id, ok: false, error: 'Could not look the comment up.' }))
  }
  const rows = new Map((data ?? []).map((r) => [(r as Row).id, r as Row]))

  const results = new Map<string, BulkResult>()
  const eligible: string[] = []
  for (const id of ids) {
    const row = rows.get(id)
    if (!row) results.set(id, { id, ok: false, error: 'Comment not found.' })
    else if (row.direction !== 'inbound') results.set(id, { id, ok: false, error: 'This is a comment from you or your page.', reason: 'ownComment' })
    else if (row.status === 'deleted') results.set(id, { id, ok: false, error: 'This comment was deleted.', reason: 'deleted' })
    else if ((op === 'resolve' || op === 'spam' || op === 'reopen') && !wouldChange(op, row.handled_status)) results.set(id, { id, ok: true, skipped: true })
    else eligible.push(id)
  }

  if (op === 'resolve' || op === 'spam' || op === 'reopen') {
    if (eligible.length > 0) {
      const { data: updated, error: updErr } = await userDb
        .from('comments')
        .update({ handled_status: STATUS_FOR[op] })
        .eq('account_id', ctx.accountId)
        .in('id', eligible)
        .select('id')
      if (updErr) console.error('[comments bulk] update failed:', updErr)
      const done = new Set((updated ?? []).map((r) => (r as { id: string }).id))
      for (const id of eligible) {
        results.set(id, done.has(id) ? { id, ok: true } : { id, ok: false, error: updErr ? 'Could not update the comment.' : 'You do not have permission to change this comment.' })
      }
    }
  } else {
    // One provider call per comment, one after another: gentle on the provider's rate limits, and a failure stays with its own comment.
    for (const id of eligible) {
      let r: ActionResult
      try {
        r = await perform(adminDb, ctx, id, op)
      } catch (err) {
        console.error('[comments bulk] action threw:', err)
        results.set(id, { id, ok: false, error: 'The provider could not be reached.' })
        continue
      }
      results.set(id, r.ok ? { id, ok: true } : { id, ok: false, error: r.error, reason: r.reason })
    }
  }

  return ids.map((id) => results.get(id) ?? { id, ok: false, error: 'Not processed.' })
}
