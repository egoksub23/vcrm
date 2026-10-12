import { CRON_INTERVALS, cronRoute } from '@/lib/cron/guard'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { runClockSweep } from '@/lib/compliance/service/jobs'

/**
 * The clock alerts of Compliance requests (migration 183), once an hour.
 *
 * One database call, `compliance_clock_alert_sweep()`: every open, unpaused case with a hard stop, in a workspace where the `compliance` flag is on,
 * that is within 10 days, within 5 days of its stop or at it, and has not been alerted for that threshold, is claimed (so it never repeats), gets a
 * `clock_alert` event and an in-app notification for the holders of compliance.approve and compliance.review. It sends no email (Part B).
 *
 * Auth: the same `AUTOMATION_CRON_SECRET` / `x-cron-secret` header as the other jobs. Schedule it hourly:
 *
 *   0 * * * * curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/compliance/clock-cron
 */
export const GET = cronRoute('compliance-clock', CRON_INTERVALS['compliance-clock'], async () => {
  try {
    const result = await runClockSweep(supabaseAdmin())
    return { body: { ...result } }
  } catch (err) {
    console.error('[compliance-clock-cron] sweep failed:', err instanceof Error ? err.message : 'unknown')
    return { status: 500, body: { error: 'sweep failed' } }
  }
})
