import { CRON_INTERVALS, cronRoute } from '@/lib/cron/guard'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { loadCapabilityRecipients } from '@/lib/auth/capability-recipients'

/** Candidates per run, and the most one workspace may contribute to a run. */
const LIMIT = 500
const PER_ACCOUNT = 100

type Candidate = {
  id: string
  account_id: string
  contact_id: string | null
  assigned_agent_id: string | null
  last_customer_message_at: string
  sla_minutes: number
}

/**
 * Sweep conversations that have breached their account's SLA response
 * target and notify someone.
 *
 * A conversation qualifies when `awaiting_response = true` (a customer
 * message arrived and nobody has replied since — migration 049),
 * `status != 'closed'`, `sla_notified_at IS NULL` (not already
 * notified for THIS wait cycle — cleared whenever a new customer
 * message arrives or we reply), and the wait has exceeded the
 * account's `sla_response_minutes`.
 *
 * The scan is done by the database (migration 135,
 * conversation_sla_candidates): it applies the breach test itself,
 * takes at most PER_ACCOUNT per workspace so one workspace's backlog
 * cannot crowd out the others, and skips suspended workspaces. It used
 * to load every waiting conversation and loop over them here.
 *
 * Recipient: the assigned agent if the conversation has one, otherwise
 * every owner/admin on the account who holds `conversations.manage` (an unassigned conversation is
 * everyone's problem, not nobody's).
 *
 * Auth: `AUTOMATION_CRON_SECRET` (src/lib/cron/guard.ts). A 5-minute
 * interval keeps the worst-case notification delay reasonable.
 */
export const GET = cronRoute('sla-conversations', CRON_INTERVALS['sla-conversations'], async () => {
  const admin = supabaseAdmin()
  const now = Date.now()

  const { data: candidates, error } = await admin.rpc('conversation_sla_candidates', {
    p_limit: LIMIT,
    p_per_account: PER_ACCOUNT,
  })

  if (error) {
    console.error('[sla-cron] candidate scan failed:', error.message)
    return { status: 500, body: { error: error.message } }
  }
  if (!candidates?.length) return { body: { notified: 0 } }

  let notified = 0
  for (const r of candidates as Candidate[]) {
    const waitingMinutes = (now - new Date(r.last_customer_message_at).getTime()) / 60000

    // Claim this breach — guarded by the precondition sla_notified_at
    // IS NULL so a concurrent sweep run can't double-notify.
    const { data: claimed } = await admin
      .from('conversations')
      .update({ sla_notified_at: new Date(now).toISOString() })
      .eq('id', r.id)
      .is('sla_notified_at', null)
      .select('id')
    if (!Array.isArray(claimed) || claimed.length === 0) continue

    let recipientIds: string[] = []
    if (r.assigned_agent_id) {
      recipientIds = [r.assigned_agent_id]
    } else {
      // Owner/admin members who still hold `conversations.manage`
      // (everyone in those roles, unless an admin switched it off).
      recipientIds = await loadCapabilityRecipients(
        admin,
        r.account_id,
        'conversations.manage',
        { roles: ['owner', 'admin'] },
      )
    }
    if (recipientIds.length === 0) continue

    let contactName = 'a contact'
    if (r.contact_id) {
      const { data: contact } = await admin
        .from('contacts')
        .select('name, phone')
        .eq('id', r.contact_id)
        .maybeSingle()
      contactName = contact?.name || contact?.phone || contactName
    }

    const waitedLabel =
      waitingMinutes >= 60
        ? `${Math.round(waitingMinutes / 60)}h`
        : `${Math.round(waitingMinutes)}m`

    await admin.from('notifications').insert(
      recipientIds.map((userId) => ({
        account_id: r.account_id,
        user_id: userId,
        type: 'sla_breach' as const,
        conversation_id: r.id,
        contact_id: r.contact_id,
        title: 'Response time exceeded',
        body: `${contactName} has been waiting ${waitedLabel} for a reply.`,
      })),
    )
    notified += 1
  }

  return { body: { notified } }
})
