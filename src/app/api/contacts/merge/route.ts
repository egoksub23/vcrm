import { NextResponse } from 'next/server'
import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'

// POST /api/contacts/merge
//
// Folds `secondary_contact_id` entirely into `primary_contact_id` —
// conversations/messages, deals, tags, notes, custom values, and
// channel-identity columns (wa_user_id, messenger_psid, etc.) — via
// the `merge_contacts` DB function (migration 059), then deletes the
// secondary contact. Agent-confirmed only: the caller (contact detail
// panel) surfaces the match and asks before ever hitting this route.

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireCapability('contacts.merge')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  const primaryContactId = typeof body?.primary_contact_id === 'string' ? body.primary_contact_id : null
  const secondaryContactId = typeof body?.secondary_contact_id === 'string' ? body.secondary_contact_id : null

  if (!primaryContactId || !secondaryContactId) {
    return NextResponse.json(
      { error: 'primary_contact_id and secondary_contact_id are required' },
      { status: 400 },
    )
  }
  if (primaryContactId === secondaryContactId) {
    return NextResponse.json({ error: 'Cannot merge a contact into itself' }, { status: 400 })
  }

  const { error } = await supabaseAdmin().rpc('merge_contacts', {
    p_account_id: ctx.accountId,
    p_primary_contact_id: primaryContactId,
    p_secondary_contact_id: secondaryContactId,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ merged: true })
}
