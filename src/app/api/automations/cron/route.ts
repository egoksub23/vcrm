import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resumePendingExecution } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'
import { CRON_INTERVALS, cronRoute, forEachWithinBudget } from '@/lib/cron/guard'

/** How many rows one run may claim, and how many of those may come from one workspace. */
const BATCH = 50
const PER_ACCOUNT = 10
/** A claimed row is leased for this long; a row still running after it is failed, not re-run. */
const LEASE_SECONDS = 600
/** Stop starting new rows after this long, so every claimed row finishes well inside its lease. */
const BUDGET_MS = 45_000

interface PendingRow {
  id: string
  automation_id: string
  account_id: string
  user_id: string | null
  contact_id: string | null
  log_id: string | null
  parent_step_id: string | null
  branch: 'yes' | 'no' | null
  next_step_position: number
  context: AutomationContext | null
}

/**
 * Drain due `automation_pending_executions` rows (the "Wait" steps of an
 * automation). Meant to be hit on a schedule (external pinger or crontab);
 * requires the shared `x-cron-secret` header (see src/lib/cron/guard.ts).
 *
 * The claim is done by the database (migration 135, automation_claim_pending):
 *   - round-robin across workspaces, so one busy workspace cannot take the
 *     whole batch and starve the others;
 *   - leased, so a crash cannot strand rows for ever (a row whose lease
 *     expires is failed visibly, never run again: its steps may have
 *     partly run, and a customer message must not go out twice);
 *   - suspended workspaces are skipped.
 * Rows claimed but not reached inside the time budget are handed back.
 */
export const GET = cronRoute('automations', CRON_INTERVALS.automations, async () => {
  const admin = supabaseAdmin()

  const { data, error } = await admin.rpc('automation_claim_pending', {
    p_limit: BATCH,
    p_per_account: PER_ACCOUNT,
    p_lease_seconds: LEASE_SECONDS,
  })
  if (error) return { status: 500, body: { error: error.message } }

  const rows = (data ?? []) as PendingRow[]
  if (rows.length === 0) return { body: { processed: 0 } }

  let failed = 0
  const { done, skipped } = await forEachWithinBudget(rows, BUDGET_MS, async (row) => {
    try {
      await resumePendingExecution({
        id: row.id,
        automation_id: row.automation_id,
        // account_id is NOT NULL on automation_pending_executions
        // post-017; the engine uses it for tenant-scoped lookups.
        account_id: row.account_id,
        user_id: row.user_id as string,
        contact_id: row.contact_id ?? null,
        log_id: row.log_id ?? null,
        parent_step_id: row.parent_step_id ?? null,
        branch: row.branch ?? null,
        next_step_position: row.next_step_position,
        context: row.context ?? {},
      })
    } catch (err) {
      // One bad row must not strand the rest of the batch.
      failed++
      console.error('[automations-cron] resume failed:', row.id, err instanceof Error ? err.message : err)
      await admin.from('automation_pending_executions').update({ status: 'failed' }).eq('id', row.id)
    }
  })

  let released = 0
  if (skipped.length > 0) {
    const { data: n } = await admin.rpc('automation_release_pending', { p_ids: skipped.map((r) => r.id) })
    released = typeof n === 'number' ? n : 0
  }

  return { body: { processed: done - failed, failed, released } }
})
