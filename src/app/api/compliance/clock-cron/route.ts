import { CRON_INTERVALS, cronRoute } from '@/lib/cron/guard'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { purgeOldCodes, runClockSweep } from '@/lib/compliance/service/jobs'
import { emailClockAlerts, realNoticeDeps } from '@/lib/compliance/service/notices'

/**
 * The clock alerts of Compliance requests (migration 183), once an hour.
 *
 * One database call, `compliance_clock_alert_sweep()`: every open, unpaused case with a hard stop, in a workspace where the `compliance` flag is on,
 * that is within 10 days, within 5 days of its stop or at it, and has not been alerted for that threshold, is claimed (so it never repeats), gets a
 * `clock_alert` event and an in-app notification for the holders of compliance.approve and compliance.review. Part B (migration 184) then emails the
 * same people for each alert (once: the event is the sweep's claim, and each email has its own claim) and removes the public forms' old emailed codes.
 *
 * Auth: the same `AUTOMATION_CRON_SECRET` / `x-cron-secret` header as the other jobs. Schedule it hourly:
 *
 *   0 * * * * curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/compliance/clock-cron
 */
export const GET = cronRoute('compliance-clock', CRON_INTERVALS['compliance-clock'], async () => {
  try {
    const admin = supabaseAdmin()
    const result = await runClockSweep(admin)
    // the emails and the housekeeping never fail the sweep: the alerts are already claimed and written
    const emails = await emailClockAlerts(admin, realNoticeDeps).catch(() => ({ looked: 0, sent: 0, skipped: 0, failed: 0 }))
    const codes = await purgeOldCodes(admin).catch(() => ({ purged: 0 }))
    return { body: { ...result, emails, codes } }
  } catch (err) {
    console.error('[compliance-clock-cron] sweep failed:', err instanceof Error ? err.message : 'unknown')
    return { status: 500, body: { error: 'sweep failed' } }
  }
})
