import { CRON_INTERVALS, cronRoute } from '@/lib/cron/guard'
import { supabaseAdmin } from '@/lib/flows/admin-client'

/**
 * Daily usage snapshot (migration 152): one row per active workspace per day
 * with its contacts, members, conversations, messages, stored files and AI
 * tokens, so the operator console can show every workspace against its plan
 * limits without counting live. Suspended workspaces are skipped. A second run
 * on the same day measures nothing.
 *
 * Auth: the same `AUTOMATION_CRON_SECRET` / `x-cron-secret` header as the other
 * jobs. Once a day, early in the morning UTC, is plenty:
 *
 *   15 1 * * * curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/usage/snapshot-cron
 */
export const GET = cronRoute('usage-snapshot', CRON_INTERVALS['usage-snapshot'], async () => {
  const { data, error } = await supabaseAdmin().rpc('usage_snapshot_run', { p_limit: 200 })
  if (error) {
    console.error('[usage-snapshot-cron] failed:', error.message)
    return { status: 500, body: { error: error.message } }
  }
  return { body: { measured: data ?? 0 } }
})
