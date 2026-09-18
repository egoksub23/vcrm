import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { getOAuthBaseUrl } from '@/lib/ms365/oauth'
import { renewMailboxSubscription } from '@/lib/ms365/subscription-renewal'

// POST /api/email/subscription-heartbeat
//
// Client-triggered companion to the cron-gated /api/email/subscription-renew
// (migration 060) — the dashboard pings this whenever an agent opens the
// Inbox or an Email(MS365) conversation, fire-and-forget. Rate-limited to
// once per 24h per account via email_config.last_renewal_checked_at, so
// normal browsing never hammers Graph: most calls are a single cheap
// read+no-op UPDATE that matches zero rows. Ties subscription upkeep to
// actual CRM usage as a second safety net, independent of whether an
// operator has a cron pinger wired up to the other route.
//
// Any authenticated account member can trigger this — it's a passive
// maintenance ping, not a privileged write the caller controls the shape
// of (the service-role client does the actual email_config write either
// way, same as every other Graph-token operation in this codebase).

const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await getCurrentAccount()
  } catch (err) {
    return toErrorResponse(err)
  }

  const admin = supabaseAdmin()
  const { data: config } = await admin
    .from('email_config')
    .select('*')
    .eq('account_id', ctx.accountId)
    .eq('status', 'connected')
    .maybeSingle()

  if (!config) {
    return NextResponse.json({ skipped: true, reason: 'not_connected' })
  }

  const cutoff = new Date(Date.now() - HEARTBEAT_INTERVAL_MS).toISOString()

  // Atomically claim the check: only proceeds if nobody (another tab,
  // another agent, the cron itself hasn't touched this column) already
  // claimed it within the last 24h. The UPDATE's own WHERE is the race
  // guard — losing the claim just means "someone beat us to it," not
  // an error.
  const { data: claimed } = await admin
    .from('email_config')
    .update({ last_renewal_checked_at: new Date().toISOString() })
    .eq('id', config.id)
    .or(`last_renewal_checked_at.is.null,last_renewal_checked_at.lt.${cutoff}`)
    .select()
    .maybeSingle()

  if (!claimed) {
    return NextResponse.json({ skipped: true, reason: 'checked_recently' })
  }

  try {
    const result = await renewMailboxSubscription({
      admin,
      config: claimed,
      baseUrl: getOAuthBaseUrl(request),
    })
    return NextResponse.json({ skipped: false, ...result })
  } catch (err) {
    // Non-fatal from the caller's point of view (fire-and-forget) — the
    // daily cron remains the authoritative retry path for a persistent
    // failure. Logged here so it's still visible in the server logs.
    console.error(
      '[email subscription-heartbeat] renew failed:',
      err instanceof Error ? err.message : err,
    )
    return NextResponse.json({ skipped: false, error: 'renew_failed' })
  }
}
