import { createClient } from '@supabase/supabase-js'

import { CRON_INTERVALS, cronRoute, forEachWithinBudget } from '@/lib/cron/guard'
import { suspendedAccountIds } from '@/lib/platform/active'
import { getValidAccessToken } from '@/lib/gmail/token'
import { watchMailbox } from '@/lib/gmail/gmail-api'

/**
 * Renews every connected mailbox's Gmail push-notification
 * registration before it expires (`users.watch` lasts at most 7
 * days). Meant to be hit on a schedule (Vercel Cron / external
 * pinger, at least once a day) — shares `AUTOMATION_CRON_SECRET` with
 * the automations Wait-step drain and the Microsoft 365 channel's
 * subscription-renew endpoint via the same `x-cron-secret` header,
 * rather than a third secret operators would need to remember to set.
 *
 * Skips any account whose GMAIL_PUBSUB_TOPIC isn't configured (or
 * whose connection never got a Pub/Sub topic to watch against) — there's
 * nothing to renew until that one-time setup is done.
 */
export const GET = cronRoute('gmail-watch-renew', CRON_INTERVALS['gmail-watch-renew'], async () => {
  const pubsubTopic = process.env.GMAIL_PUBSUB_TOPIC?.trim()
  if (!pubsubTopic) {
    return { body: { renewed: 0, skipped: 'GMAIL_PUBSUB_TOPIC not configured' } }
  }

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // Renew anything expiring within the next 48 hours (a watch lasts up to
  // 7 days), plus anything lapsed or never set. Soonest first and capped,
  // so a backlog is worked through over successive runs; suspended
  // workspaces are left alone.
  const soon = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
  const { data: configs, error } = await admin
    .from('gmail_config')
    .select('*')
    .eq('status', 'connected')
    .or(`watch_expiration.is.null,watch_expiration.lte.${soon}`)
    .order('watch_expiration', { ascending: true, nullsFirst: true })
    .limit(500)

  if (error) return { status: 500, body: { error: error.message } }
  const suspended = await suspendedAccountIds(admin)
  const eligible = (configs ?? []).filter((c) => !suspended.has(c.account_id as string))
  if (eligible.length === 0) return { body: { renewed: 0 } }

  let renewed = 0
  let failed = 0
  const { skipped } = await forEachWithinBudget(eligible, 45_000, async (config) => {
    try {
      const accessToken = await getValidAccessToken(config)
      const watch = await watchMailbox({ accessToken, topicName: pubsubTopic })
      const update: Record<string, unknown> = { watch_expiration: watch.expiration }
      if (!config.history_id) update.history_id = watch.historyId
      await admin.from('gmail_config').update(update).eq('id', config.id)
      renewed++
    } catch (err) {
      failed++
      console.error(
        `[gmail watch-renew] failed for account ${config.account_id}:`,
        err instanceof Error ? err.message : err,
      )
    }
  })

  return { body: { renewed, failed, deferred: skipped.length } }
})
