import { CRON_INTERVALS, cronRoute } from '@/lib/cron/guard'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { runDueDeletions } from '@/lib/platform/deletion'

/**
 * Workspace deletions (migration 153). Picks up every deletion whose 30 days
 * (or the operator's shorter wait) are up, and any that stopped half way, and
 * runs them: external registrations switched off, stored files removed, every
 * row deleted, the workspace's logins deleted. A few per run; hourly is plenty.
 *
 * Auth: the same `AUTOMATION_CRON_SECRET` / `x-cron-secret` header as the other jobs:
 *
 *   30 * * * * curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/platform/deletion-cron
 */
export const GET = cronRoute('workspace-deletion', CRON_INTERVALS['workspace-deletion'], async () => {
  const results = await runDueDeletions(supabaseAdmin(), 3)
  const failed = results.filter((r) => !r.ok).length
  return { status: failed > 0 ? 500 : 200, body: { deleted: results.length - failed, failed, results } }
})
