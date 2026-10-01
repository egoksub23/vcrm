import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
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

  const { data, error } = await supabaseAdmin().rpc('sweep_stuck_sending_messages', {
    p_stale_minutes: 10,
  })
  if (error) {
    console.error('[messages-sweep-cron] sweep failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json(data?.[0] ?? { recovered: 0 })
}
