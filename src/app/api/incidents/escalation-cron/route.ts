import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { notifyIncidentEmail } from '@/lib/email/incident-notification-email'

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
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data, error } = await supabaseAdmin().rpc('incident_escalation_sweep', { p_limit: 200 })
  if (error) {
    console.error('[incidents-escalation-cron] sweep failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Best-effort email on top of the in-app notification the sweep already
  // inserted — never blocks the response; the sweep itself already
  // committed by the time this runs.
  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL
  const notified = (data?.notified ?? []) as SweepNotified[]
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

  return NextResponse.json(data ?? { escalated: 0, notifications: 0 })
}
