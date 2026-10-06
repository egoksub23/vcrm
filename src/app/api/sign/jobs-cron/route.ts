import { CRON_INTERVALS, cronRoute } from '@/lib/cron/guard'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { realDeps } from '@/lib/sign/notify'
import { runAll } from '@/lib/sign/service/jobs'
import { publicOrigin } from '@/lib/site-url'

/**
 * The scheduled work of Doc Sign, once a minute: seal documents that every signer has finished (two at
 * a time, oldest first), expire documents past their date, and send due reminders. Each part works on a
 * small batch, so one workspace's backlog cannot starve another's.
 *
 * Auth: the same `AUTOMATION_CRON_SECRET` / `x-cron-secret` header as the other jobs.
 *
 *   * * * * * curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/sign/jobs-cron
 */
export const GET = cronRoute('sign-jobs', CRON_INTERVALS['sign-jobs'], async (request) => {
  const origin = publicOrigin() || new URL(request.url).origin
  const body = await runAll({ admin: supabaseAdmin(), origin, deps: realDeps, now: () => new Date() })
  return { body }
})
