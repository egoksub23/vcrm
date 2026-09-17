// ============================================================
// GET /api/account/channels/messenger/oauth/pages?connection_id=
//
// Returns the Page picker list for a pending connection that landed
// in `awaiting_page_selection` (the admin manages more than one Page).
// ============================================================
import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { findPendingConnectionById } from '@/lib/meta/oauth-connect'

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const { searchParams } = new URL(request.url)
    const connectionId = searchParams.get('connection_id')
    if (!connectionId) {
      return NextResponse.json({ error: 'connection_id is required' }, { status: 400 })
    }

    const pending = await findPendingConnectionById(supabaseAdmin(), connectionId)
    if (!pending || pending.account_id !== ctx.accountId || pending.channel !== 'messenger') {
      return NextResponse.json({ error: 'Connection not found or expired' }, { status: 404 })
    }

    return NextResponse.json({ pages: pending.pages_json ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
