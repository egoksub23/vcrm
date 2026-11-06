import { CRON_INTERVALS, cronRoute } from '@/lib/cron/guard'
import { createAdminPgDb } from '@/lib/postgres/db'
import { notifyIncidentEmail } from '@/lib/email/incident-notification-email'
import { runIncidentCron } from '@/lib/incidents/platform/run'

interface SweepNotified {
  user_id: string
  incident_id: string
  key: string
  severity: string
  title: string
  level: number
}

/**
 * Sweep incident escalation (migration 116).
 *
 * One database call, `incident_escalation_sweep(200)`: every incident still
 * in 'reported' status (unacknowledged) whose current escalation level has
 * been open longer than its (severity, level) threshold advances one level
 * and notifies the new level's recipients — Level 2 is every Admin, Level 3
 * is the Owner. Auto-escalation stops once a Compliance Officer moves the
 * incident out of 'reported' (triaged/contained/...) or it reaches Level 3.
 *
 * Auth: the same `AUTOMATION_CRON_SECRET` / `x-cron-secret` header as the
 * ticket SLA sweep. Schedule it every minute:
 *
 *   * * * * * curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/incidents/escalation-cron
 */
export const GET = cronRoute('incident-escalation', CRON_INTERVALS['incident-escalation'], async () => {
  const { data, error } = await createAdminPgDb().rpc('incident_escalation_sweep', { p_limit: 200 })
  if (error) {
    console.error('[incidents-escalation-cron] sweep failed:', error.message)
    return { status: 500, body: { error: error.message } }
  }

  const appBaseUrl = process.env.NEXT_PUBLIC_SITE_URL
  const rpcData = data as { notified?: SweepNotified[]; escalated?: number; notifications?: number } | null
  const notified = (rpcData?.notified ?? []) as SweepNotified[]
  if (appBaseUrl && notified.length > 0) {
    await Promise.allSettled(
      notified.map((n) =>
        notifyIncidentEmail({
          userIds: [n.user_id],
          kind: 'escalated',
          key: n.key,
          title: n.title,
          severity: n.severity,
          detail: `Unacknowledged and escalated to level ${n.level}.`,
          incidentId: n.incident_id,
          appBaseUrl,
        }),
      ),
    )
  }

  // Role-based rules (migration 209): timed rules (nobody acknowledged, step overdue), then the outbox. Failures are logged and never fail the heartbeat.
  let rules: { unacknowledged: number; overdueSteps: number; sent: number; failed: number } | null = null
  try {
    rules = await runIncidentCron()
  } catch (err) {
    console.error('[incidents-escalation-cron] rules sweep failed:', err)
  }

  // The per-recipient detail stays out of the stored heartbeat result.
  return { body: { escalated: rpcData?.escalated ?? 0, notifications: rpcData?.notifications ?? 0, rules } }
})
