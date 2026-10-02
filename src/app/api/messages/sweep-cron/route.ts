import { CRON_INTERVALS, cronRoute } from '@/lib/cron/guard'
import { supabaseAdmin } from '@/lib/flows/admin-client'

/**
 * Recover a message stuck at `status = 'sending'` (migration 127).
 *
 * The only place a `messages` row is ever set to `'sending'` in the
 * database is the Resend route's claim step (`failed -> sending`) — a
 * first-time send only writes a row after the channel call already
 * resolved, success or failed. If the server dies between that claim
 * and the outcome, the row is stuck: the resend route refuses to touch
 * a `'sending'` row again (409), and the UI only wires Resend/Delete
 * for `'failed'`. `sweep_stuck_sending_messages()` flips anything past
 * the staleness window back to `'failed'` with a generic "interrupted"
 * reason, so it becomes resendable again.
 *
 * Auth: the same `AUTOMATION_CRON_SECRET` / `x-cron-secret` header as
 * the other sweeps. This is a rare crash-timing edge case, not a
 * time-sensitive one — every 5 minutes is plenty:
 *
 *   star-slash-5 * * * * curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/messages/sweep-cron
 */
export const GET = cronRoute('message-sweep', CRON_INTERVALS['message-sweep'], async () => {
  const { data, error } = await supabaseAdmin().rpc('sweep_stuck_sending_messages', {
    p_stale_minutes: 10,
  })
  if (error) {
    console.error('[messages-sweep-cron] sweep failed:', error.message)
    return { status: 500, body: { error: error.message } }
  }
  return { body: data?.[0] ?? { recovered: 0 } }
})
