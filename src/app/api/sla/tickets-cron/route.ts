import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
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
 * Auth: the same `AUTOMATION_CRON_SECRET` / `x-cron-secret` header as the
 * other sweeps. Schedule it every minute (the state on screen does not wait
 * for it: a running target past its due time is shown as breached at once;
 * this sweep is what stores that and sends the notifications):
 *
 *   * * * * * curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/sla/tickets-cron
 *
 * The conversation response-time sweep (`/api/sla/cron`) is separate and
 * unchanged.
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

  const { data, error } = await supabaseAdmin().rpc('sla_sweep', { p_limit: 200 })
  if (error) {
    console.error('[tickets-sla-cron] sweep failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json(data ?? { breached: 0, tickets_notified: 0, notifications: 0 })
}
