// ============================================================
// POST /api/contacts/merge-suggestions/[id]     { action: 'merge' | 'dismiss' }
//
// Resolves a "Possible duplicate" the web widget recorded (an unverified
// claim matched two different contacts and was NOT merged automatically).
//
//   merge    folds contact B into contact A with `merge_contacts`
//            (migration 059), the same function the manual contact merge
//            uses, gated by the same capability ('contacts.merge').
//   dismiss  marks the pair dismissed; it is never suggested again.
//
// Only a pending suggestion can be resolved (409 otherwise). All writes use
// the service role: the table has no client write policy on purpose.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability('contacts.merge')
    const { id } = await params

    const body = (await request.json().catch(() => null)) as { action?: unknown } | null
    const action = body?.action
    if (action !== 'merge' && action !== 'dismiss') {
      return NextResponse.json({ error: "action must be 'merge' or 'dismiss'" }, { status: 400 })
    }

    const admin = supabaseAdmin()
    const { data: suggestion, error } = await admin
      .from('contact_merge_suggestions')
      .select('id, account_id, contact_a_id, contact_b_id, status')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (error) {
      console.error('[POST merge-suggestions] lookup error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
    if (!suggestion) return NextResponse.json({ error: 'Suggestion not found' }, { status: 404 })
    if (suggestion.status !== 'pending') {
      return NextResponse.json({ error: 'This suggestion was already resolved' }, { status: 409 })
    }

    const resolved = { resolved_by: ctx.userId, resolved_at: new Date().toISOString() }

    if (action === 'dismiss') {
      // Guarded on status so two agents clicking at once resolve it once.
      const { error: updateError } = await admin
        .from('contact_merge_suggestions')
        .update({ status: 'dismissed', ...resolved })
        .eq('id', id)
        .eq('status', 'pending')
      if (updateError) {
        console.error('[POST merge-suggestions] dismiss error:', updateError)
        return NextResponse.json({ error: 'Failed to dismiss' }, { status: 500 })
      }
      return NextResponse.json({ ok: true, status: 'dismissed' })
    }

    // Claim the suggestion first so a double click cannot merge twice.
    const { data: claimed } = await admin
      .from('contact_merge_suggestions')
      .update({ status: 'merged', ...resolved })
      .eq('id', id)
      .eq('status', 'pending')
      .select('id')
    if (!claimed || claimed.length === 0) {
      return NextResponse.json({ error: 'This suggestion was already resolved' }, { status: 409 })
    }

    const { error: mergeError } = await admin.rpc('merge_contacts', {
      p_account_id: ctx.accountId,
      p_primary_contact_id: suggestion.contact_a_id,
      p_secondary_contact_id: suggestion.contact_b_id,
    })
    if (mergeError) {
      console.error('[POST merge-suggestions] merge_contacts failed:', mergeError)
      // Put it back so the agent can retry or dismiss.
      await admin
        .from('contact_merge_suggestions')
        .update({ status: 'pending', resolved_by: null, resolved_at: null })
        .eq('id', id)
      return NextResponse.json({ error: 'Could not merge these contacts' }, { status: 500 })
    }

    // merge_contacts deletes contact B, which removes this row by cascade;
    // returning the surviving contact lets the inbox refresh onto it.
    return NextResponse.json({ ok: true, status: 'merged', contact_id: suggestion.contact_a_id })
  } catch (err) {
    return toErrorResponse(err)
  }
}
