import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

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

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // Renew anything expiring within the next 24 hours, plus anything
  // that never got a subscription id at all.
  const soon = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  const { data: configs, error } = await admin
    .from('email_config')
    .select('*')
    .eq('status', 'connected')
    .or(`subscription_expires_at.is.null,subscription_expires_at.lte.${soon}`)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!configs || configs.length === 0) return NextResponse.json({ renewed: 0 })

  let renewed = 0
  let failed = 0
  for (const config of configs) {
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
  }

  return NextResponse.json({ renewed, failed })
}
