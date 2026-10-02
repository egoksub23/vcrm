// ============================================================
// Shared plumbing for the scheduled-job endpoints (/api/*/cron and the
// renewal routes): one constant-time secret check, one place that times
// the run, and a heartbeat so the operator console can see when each job
// last ran and flag one that has silently stopped (a missing crontab
// line).
//
// Every job route is now
//
//   export const GET = cronRoute('automations', 300, async () => { ... return { body } })
//
// Auth contract (unchanged from the per-route copies this replaces):
// 503 when AUTOMATION_CRON_SECRET is not set, 401 for a missing or wrong
// `x-cron-secret`, compared in constant time.
// ============================================================
import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'

export interface CronResult {
  /** JSON body returned to the caller and kept as the run's last result. */
  body: Record<string, unknown>
  /** HTTP status; defaults to 200. 4xx/5xx record the run as an error. */
  status?: number
}

/** Null when the request carries the right secret, otherwise the response to send. */
export function checkCronSecret(request: Request): NextResponse | null {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  // Constant-time compare so a caller cannot recover the secret from
  // response-time differences. The length pre-check is required by
  // timingSafeEqual and leaks only the length, which is not sensitive.
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const want = Buffer.from(expected)
  if (supplied.length !== want.length || !timingSafeEqual(supplied, want)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

/** Best effort: a heartbeat that cannot be written must never fail a job. */
async function recordHeartbeat(
  job: string,
  expectedSeconds: number,
  durationMs: number,
  ok: boolean,
  result: Record<string, unknown>,
): Promise<void> {
  try {
    await supabaseAdmin().rpc('cron_heartbeat', {
      p_job: job,
      p_expected_seconds: expectedSeconds,
      p_duration_ms: Math.min(Math.round(durationMs), 2_000_000_000),
      p_status: ok ? 'ok' : 'error',
      // Keep the stored result small: counts and short strings, not payloads.
      p_result: JSON.parse(JSON.stringify(result, (_k, v) => (typeof v === 'string' && v.length > 200 ? v.slice(0, 200) : v))),
    })
  } catch {
    // swallowed on purpose
  }
}

/**
 * Wrap a job. `expectedSeconds` is how often it should run; the console
 * calls a job "late" after three of those.
 */
export function cronRoute(
  job: string,
  expectedSeconds: number,
  run: (request: Request) => Promise<CronResult>,
): (request: Request) => Promise<NextResponse> {
  return async (request: Request) => {
    const denied = checkCronSecret(request)
    if (denied) return denied

    const started = Date.now()
    try {
      const { body, status = 200 } = await run(request)
      await recordHeartbeat(job, expectedSeconds, Date.now() - started, status < 400, body)
      return NextResponse.json(body, { status })
    } catch (err) {
      console.error(`[cron ${job}] failed:`, err instanceof Error ? err.message : err)
      await recordHeartbeat(job, expectedSeconds, Date.now() - started, false, {
        error: err instanceof Error ? err.message : 'failed',
      })
      return NextResponse.json({ error: 'cron failed' }, { status: 500 })
    }
  }
}

/**
 * Run `work` over `items` one at a time until `budgetMs` has passed.
 * Returns the items it did not reach, so the caller can hand them back
 * (release a lease) instead of leaving them half-claimed.
 */
export async function forEachWithinBudget<T>(
  items: readonly T[],
  budgetMs: number,
  work: (item: T) => Promise<void>,
  now: () => number = Date.now,
): Promise<{ done: number; skipped: T[] }> {
  const deadline = now() + budgetMs
  let done = 0
  for (let i = 0; i < items.length; i++) {
    if (now() >= deadline) return { done, skipped: items.slice(i) }
    await work(items[i])
    done++
  }
  return { done, skipped: [] }
}

/** Expected run interval of each job, in seconds (one place, used by routes and docs). */
export const CRON_INTERVALS = {
  automations: 300,
  flows: 3600,
  'sla-conversations': 300,
  'sla-tickets': 60,
  'incident-escalation': 60,
  jira: 120,
  'message-sweep': 300,
  'mailbox-renew': 86_400,
  'gmail-watch-renew': 86_400,
} as const
