import { CRON_INTERVALS, cronRoute } from '@/lib/cron/guard'
import { supabaseAdmin } from '@/lib/flows/admin-client'

/**
 * Sweep ticket SLAs (migration 086).
 *
 * One database call, `sla_sweep(200)`: running first-response / resolution
 * targets that are past their due time become `breached`, and each ticket
 * target is announced ONCE, at risk (the policy's at-risk percent of the
 * target used up) and breached, to the assignee (every Owner/Admin when the
 * ticket is unassigned) plus the ticket's watchers. Paused targets (a ticket
 * waiting on the customer) and finished tickets are left alone. The database
 * takes a batch of at most 200 tickets per phase with FOR UPDATE SKIP LOCKED,
 * so two overlapping runs never take the same ticket; a backlog drains over
 * the next runs.
 *
 * Fair across workspaces and skipping suspended ones (migration 135).
 *
 * Auth: the same `AUTOMATION_CRON_SECRET` / `x-cron-secret` header as the
 * other sweeps (src/lib/cron/guard.ts). Schedule it every minute (the state on screen does not wait
 * for it: a running target past its due time is shown as breached at once;
 * this sweep is what stores that and sends the notifications):
 *
 *   * * * * * curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/sla/tickets-cron
 *
 * The conversation response-time sweep (`/api/sla/cron`) is separate and
 * unchanged.
 */
export const GET = cronRoute('sla-tickets', CRON_INTERVALS['sla-tickets'], async () => {
  const { data, error } = await supabaseAdmin().rpc('sla_sweep', { p_limit: 200 })
  if (error) {
    console.error('[tickets-sla-cron] sweep failed:', error.message)
    return { status: 500, body: { error: error.message } }
  }
  return { body: data ?? { breached: 0, tickets_notified: 0, notifications: 0 } }
})
