import { CRON_INTERVALS, cronRoute } from '@/lib/cron/guard'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { resolveFallbackPolicy } from '@/lib/flows/fallback'
import { suspendedAccountIds } from '@/lib/platform/active'

/** Rows read per page, and how long one run may keep reading and sweeping. */
const PAGE_SIZE = 500
const BUDGET_MS = 40_000

type Row = {
  id: string
  flow_id: string
  account_id: string | null
  user_id: string | null
  contact_id: string | null
  last_advanced_at: string
  flows: { fallback_policy: unknown } | { fallback_policy: unknown }[] | null
}

/**
 * Sweep abandoned active flow runs.
 *
 * Reads each active run's parent-flow `fallback_policy.on_timeout_hours`
 * to compute the staleness cutoff (default 24h), then marks any run
 * past its cutoff as `timed_out`. Writes a matching `flow_run_events`
 * row for the audit trail.
 *
 * Without this sweep, a customer who abandons a flow mid-conversation
 * keeps a row in `idx_one_active_run_per_contact` (the partial unique
 * index on `flow_runs WHERE status='active'`) forever — blocking any
 * new triggers for them. The cron is therefore not optional.
 *
 * Reads the active runs a page at a time, stalest first, inside a time
 * budget (a single unpaged read was silently capped by the database at
 * about 1,000 rows, so everything past that was never swept), and leaves
 * a suspended workspace's runs alone.
 *
 * Auth: re-uses `AUTOMATION_CRON_SECRET` (src/lib/cron/guard.ts). A
 * 5-minute interval is more than enough for a 24h timeout default; once
 * per hour is acceptable for low-volume deployments.
 */
export const GET = cronRoute('flows', CRON_INTERVALS.flows, async () => {
  const admin = supabaseAdmin()
  const now = new Date()
  const deadline = Date.now() + BUDGET_MS

  const suspended = await suspendedAccountIds(admin)

  let scanned = 0
  let swept = 0
  let truncated = false

  // Keyset paging (not an offset): sweeping a run takes it out of the
  // 'active' set, which would shift every later offset and skip rows.
  let cursor: { at: string; id: string } | null = null

  for (;;) {
    if (Date.now() >= deadline) {
      truncated = true
      break
    }

    let query = admin
      .from('flow_runs')
      .select('id, flow_id, account_id, user_id, contact_id, last_advanced_at, flows ( fallback_policy )')
      .eq('status', 'active')
      .order('last_advanced_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(PAGE_SIZE)
    if (cursor) {
      query = query.or(
        `last_advanced_at.gt.${cursor.at},and(last_advanced_at.eq.${cursor.at},id.gt.${cursor.id})`,
      )
    }
    const { data: runs, error } = await query

    if (error) {
      console.error('[flows-cron] active-run scan failed:', error.message)
      return { status: 500, body: { error: error.message } }
    }
    if (!runs || runs.length === 0) break

    for (const r of runs as Row[]) {
      scanned++
      if (r.account_id && suspended.has(r.account_id)) continue

      const flowsField = Array.isArray(r.flows) ? r.flows[0] : r.flows
      const policy = resolveFallbackPolicy(flowsField?.fallback_policy ?? null)
      const lastAdvanced = new Date(r.last_advanced_at)
      const ageHours = (now.getTime() - lastAdvanced.getTime()) / (1000 * 60 * 60)
      if (ageHours < policy.on_timeout_hours) continue

      // Mark timed_out — guarded by the precondition `status='active'`
      // so concurrent advance from a late inbound doesn't overwrite a
      // legitimate update.
      const { data: updated } = await admin
        .from('flow_runs')
        .update({
          status: 'timed_out',
          ended_at: now.toISOString(),
          end_reason: 'stale_sweep',
        })
        .eq('id', r.id)
        .eq('status', 'active')
        .select('id')

      if (Array.isArray(updated) && updated.length > 0) {
        await admin.from('flow_run_events').insert({
          flow_run_id: r.id,
          event_type: 'timeout',
          payload: {
            age_hours: Math.round(ageHours * 10) / 10,
            policy_hours: policy.on_timeout_hours,
          },
        })
        swept += 1
      }
    }

    if (runs.length < PAGE_SIZE) break
    const last = runs[runs.length - 1] as Row
    cursor = { at: last.last_advanced_at, id: last.id }
  }

  return { body: { swept, scanned, truncated } }
})
