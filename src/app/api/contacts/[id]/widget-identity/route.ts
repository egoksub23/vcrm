// ============================================================
// GET /api/contacts/[id]/widget-identity
//
// What the inbox thread header shows for a web-widget contact:
//   level        the strongest identity a widget browser of this contact has
//                proven: 'verified' (signed in-app token) > 'claimed' (typed,
//                unverified) > 'guest' (anonymous). null when the contact has
//                never used the widget.
//   source       how that level was reached (typed | signed_app | code)
//   suggestions  pending "Possible duplicate" pairs involving this contact
//
// Any member of the account may read it. `widget_visitors` has no client
// policy (only the service role reads it), so it is read with the admin
// client AFTER the contact is confirmed to belong to the caller's account.
// ============================================================
import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { strongestIdentity } from '@/lib/widget/identity-summary'

interface OtherContact {
  id: string
  name: string | null
  phone: string | null
  email: string | null
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getCurrentAccount()
    const { id: contactId } = await params

    const { data: contact, error: contactError } = await ctx.supabase
      .from('contacts')
      .select('id')
      .eq('id', contactId)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (contactError) {
      console.error('[GET widget-identity] contact lookup error:', contactError)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
    if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })

    const admin = supabaseAdmin()
    const { data: visitors, error: visitorError } = await admin
      .from('widget_visitors')
      .select('identity_level, identity_source')
      .eq('contact_id', contactId)
      .eq('account_id', ctx.accountId)
    if (visitorError) {
      // Migration 092 not applied yet: behave as "no widget identity".
      console.error('[GET widget-identity] visitors lookup error:', visitorError)
    }
    const { level, source } = strongestIdentity(
      (visitors ?? []) as { identity_level: string | null; identity_source: string | null }[],
    )

    const { data: pending } = await ctx.supabase
      .from('contact_merge_suggestions')
      .select('id, contact_a_id, contact_b_id, created_at')
      .eq('account_id', ctx.accountId)
      .eq('status', 'pending')
      .or(`contact_a_id.eq.${contactId},contact_b_id.eq.${contactId}`)
      .order('created_at', { ascending: false })
      .limit(10)

    const rows = (pending ?? []) as { id: string; contact_a_id: string; contact_b_id: string; created_at: string }[]
    const otherIds = rows.map((r) => (r.contact_a_id === contactId ? r.contact_b_id : r.contact_a_id))
    const others = new Map<string, OtherContact>()
    if (otherIds.length > 0) {
      const { data: contacts } = await ctx.supabase
        .from('contacts')
        .select('id, name, phone, email')
        .eq('account_id', ctx.accountId)
        .in('id', otherIds)
      for (const c of (contacts ?? []) as OtherContact[]) others.set(c.id, c)
    }

    const suggestions = rows.flatMap((r, i) => {
      const other = others.get(otherIds[i])
      return other
        ? [
            {
              id: r.id,
              other_contact: { id: other.id, name: other.name, phone: other.phone, email: other.email },
              created_at: r.created_at,
            },
          ]
        : []
    })

    return NextResponse.json({ level, source, suggestions })
  } catch (err) {
    return toErrorResponse(err)
  }
}
