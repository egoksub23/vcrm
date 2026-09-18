import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

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

  const pubsubTopic = process.env.GMAIL_PUBSUB_TOPIC?.trim()
  if (!pubsubTopic) {
    return NextResponse.json({ renewed: 0, skipped: 'GMAIL_PUBSUB_TOPIC not configured' })
  }

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // Renew anything expiring within the next 48 hours (watch lasts up
  // to 7 days, so daily-or-more-often coverage leaves ample slack),
  // plus anything that never registered a watch at all.
  const soon = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
  const { data: configs, error } = await admin
    .from('gmail_config')
    .select('*')
    .eq('status', 'connected')
    .or(`watch_expiration.is.null,watch_expiration.lte.${soon}`)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!configs || configs.length === 0) return NextResponse.json({ renewed: 0 })

  let renewed = 0
  let failed = 0
  for (const config of configs) {
    try {
      const accessToken = await getValidAccessToken(config)
      const watch = await watchMailbox({ accessToken, topicName: pubsubTopic })
      // Re-registering the watch does NOT reset Gmail's history log —
      // `watch`'s returned historyId is just "current as of now", not
      // a new starting point. Overwriting an already-set history_id
      // with it would silently skip every message that arrived
      // between the last processed notification and this renewal, so
      // only use it to establish a first-time baseline.
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
  }

  return NextResponse.json({ renewed, failed })
}
