// ============================================================
// POST /api/account/channels/instagram/comments  (admin)
//
// Turn on comment events for the connected instagram account (subscribes the
// Page to the comment webhook fields). Safe to repeat.
// ============================================================
import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { enableChannelComments } from '@/lib/comments/enable-comments'

export async function POST() {
  try {
    const ctx = await requireRole('admin')
    const r = await enableChannelComments(supabaseAdmin(), ctx.accountId, 'instagram')
    if (!r.ok) {
      return NextResponse.json({ error: r.error, reconnect: r.reconnect ?? false }, { status: r.status })
    }
    return NextResponse.json({ enabled: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
