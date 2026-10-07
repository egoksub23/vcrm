import { CRON_INTERVALS, cronRoute } from '@/lib/cron/guard'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { realDeps } from '@/lib/sign/notify'
import { runAll, sealingIsFailing } from '@/lib/sign/service/jobs'
import { publicOrigin } from '@/lib/site-url'

/**
 * The scheduled work of Doc Sign, once a minute: seal documents that every signer has finished (two at
 * a time, oldest first), expire documents past their date, send due reminders, and send the documents of bulk
 * batches (a fair share per workspace, within a time budget). Each part works on a small batch, so one
 * workspace's backlog cannot starve another's.
 *
 * Sealing the signed copy is also tried right after a person's last signature (service/seal.ts `sealSoon`); this job is the safety net: it retries,
 * and tells the heartbeat when sealing is failing.
 *
 * Auth: the same `AUTOMATION_CRON_SECRET` / `x-cron-secret` header as the other jobs.
 *
 *   * * * * * curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/sign/jobs-cron
 */
export const GET = cronRoute('sign-jobs', CRON_INTERVALS['sign-jobs'], async (request) => {
  const origin = publicOrigin() || new URL(request.url).origin
  const body = await runAll({ admin: supabaseAdmin(), origin, deps: realDeps, now: () => new Date() })
  // A run in which documents were tried and NONE could be sealed is a failing job, not a quiet one: the heartbeat is recorded as an error (the
  // Platform console flags it, `curl -f` exits non-zero) and the body says why (`seal_error`). The reasons are also on each document.
  return { body, ...(sealingIsFailing(body) ? { status: 500 } : {}) }
})
