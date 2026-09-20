import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { loadCapabilityRecipients } from '@/lib/auth/capability-recipients'

/**
 * Sweep conversations that have breached their account's SLA response
 * target and notify someone.
 *
 * A conversation qualifies when `awaiting_response = true` (a customer
 * message arrived and nobody has replied since — migration 049),
 * `status != 'closed'`, `sla_notified_at IS NULL` (not already
 * notified for THIS wait cycle — cleared whenever a new customer
 * message arrives or we reply), and the wait has exceeded the
 * account's `sla_response_minutes`.
 *
 * Recipient: the assigned agent if the conversation has one, otherwise
 * every owner/admin on the account who holds `conversations.manage` (an unassigned conversation is
 * everyone's problem, not nobody's).
 *
 * Auth: reuses `AUTOMATION_CRON_SECRET`, same header contract as
 * `/api/flows/cron` and `/api/automations/cron` — operators only need
 * to provision one secret across all three sweeps. Hit on a schedule
 * (Vercel Cron / GitHub Actions / external pinger); a 5-minute
 * interval keeps the worst-case notification delay reasonable without
 * being a meaningfully heavier poll than the flow-timeout sweep.
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

  const admin = supabaseAdmin()
  const now = Date.now()

  const { data: candidates, error } = await admin
    .from('conversations')
    .select(
      'id, account_id, contact_id, assigned_agent_id, last_customer_message_at, accounts ( sla_response_minutes )',
    )
    .eq('awaiting_response', true)
    .is('sla_notified_at', null)
    .neq('status', 'closed')

  if (error) {
    console.error('[sla-cron] candidate scan failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!candidates?.length) return NextResponse.json({ notified: 0 })

  type Row = {
    id: string
    account_id: string
    contact_id: string | null
    assigned_agent_id: string | null
    last_customer_message_at: string | null
    accounts: { sla_response_minutes: number } | { sla_response_minutes: number }[] | null
  }

  let notified = 0
  for (const r of candidates as Row[]) {
    if (!r.last_customer_message_at) continue
    const accountField = Array.isArray(r.accounts) ? r.accounts[0] : r.accounts
    const targetMinutes = accountField?.sla_response_minutes ?? 30
    const waitingMinutes = (now - new Date(r.last_customer_message_at).getTime()) / 60000
    if (waitingMinutes < targetMinutes) continue

    // Claim this breach — guarded by the precondition sla_notified_at
    // IS NULL so a concurrent sweep run can't double-notify.
    const { data: claimed } = await admin
      .from('conversations')
      .update({ sla_notified_at: new Date(now).toISOString() })
      .eq('id', r.id)
      .is('sla_notified_at', null)
      .select('id')
    if (!Array.isArray(claimed) || claimed.length === 0) continue

    let recipientIds: string[] = []
    if (r.assigned_agent_id) {
      recipientIds = [r.assigned_agent_id]
    } else {
      // Owner/admin members who still hold `conversations.manage`
      // (everyone in those roles, unless an admin switched it off).
      recipientIds = await loadCapabilityRecipients(
        admin,
        r.account_id,
        'conversations.manage',
        { roles: ['owner', 'admin'] },
      )
    }
    if (recipientIds.length === 0) continue

    let contactName = 'a contact'
    if (r.contact_id) {
      const { data: contact } = await admin
        .from('contacts')
        .select('name, phone')
        .eq('id', r.contact_id)
        .maybeSingle()
      contactName = contact?.name || contact?.phone || contactName
    }

    const waitedLabel =
      waitingMinutes >= 60
        ? `${Math.round(waitingMinutes / 60)}h`
        : `${Math.round(waitingMinutes)}m`

    await admin.from('notifications').insert(
      recipientIds.map((userId) => ({
        account_id: r.account_id,
        user_id: userId,
        type: 'sla_breach' as const,
        conversation_id: r.id,
        contact_id: r.contact_id,
        title: 'Response time exceeded',
        body: `${contactName} has been waiting ${waitedLabel} for a reply.`,
      })),
    )
    notified += 1
  }

  return NextResponse.json({ notified })
}
