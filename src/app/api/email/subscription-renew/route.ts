import { createClient } from '@supabase/supabase-js'

import { CRON_INTERVALS, cronRoute, forEachWithinBudget } from '@/lib/cron/guard'
import { suspendedAccountIds } from '@/lib/platform/active'

import { getOAuthBaseUrl } from '@/lib/ms365/oauth'
import { renewMailboxSubscription } from '@/lib/ms365/subscription-renewal'

/**
 * Renews every connected mailbox's Graph change-notification
 * subscription before it expires (max ~4230 minutes / ~2.94 days —
 * see src/lib/ms365/mail-api.ts). Meant to be hit on a schedule
 * (Vercel Cron / external pinger, at least once a day) — shares
 * `AUTOMATION_CRON_SECRET` with the automations Wait-step drain
 * (src/app/api/automations/cron/route.ts) via the same `x-cron-secret`
 * header, rather than a second secret operators would need to remember
 * to set.
 *
 * Self-heals a subscription that's already lapsed (or was never
 * created) by creating a fresh one instead of renewing, using the same
 * notificationUrl/clientState the connection was set up with — this
 * covers the case where a renewal was missed for long enough that
 * Graph deleted the subscription outright.
 */
export const GET = cronRoute('mailbox-renew', CRON_INTERVALS['mailbox-renew'], async (request) => {
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // Renew anything expiring within the next 24 hours, plus anything
  // already lapsed or never set. Soonest-to-expire first and capped, so a
  // large backlog is worked through over successive runs instead of one
  // run that never finishes; suspended workspaces are left alone.
  const soon = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  const { data: configs, error } = await admin
    .from('email_config')
    .select('*')
    .eq('status', 'connected')
    .or(`subscription_expires_at.is.null,subscription_expires_at.lte.${soon}`)
    .order('subscription_expires_at', { ascending: true, nullsFirst: true })
    .limit(500)

  if (error) return { status: 500, body: { error: error.message } }
  const suspended = await suspendedAccountIds(admin)
  const eligible = (configs ?? []).filter((c) => !suspended.has(c.account_id as string))
  if (eligible.length === 0) return { body: { renewed: 0 } }

  let renewed = 0
  let failed = 0
  const { skipped } = await forEachWithinBudget(eligible, 45_000, async (config) => {
    try {
      await renewMailboxSubscription({
        admin,
        config,
        baseUrl: getOAuthBaseUrl(request),
      })
      renewed++
    } catch (err) {
      failed++
      console.error(
        `[email subscription-renew] failed for account ${config.account_id}:`,
        err instanceof Error ? err.message : err,
      )
    }
  })

  return { body: { renewed, failed, deferred: skipped.length } }
})
