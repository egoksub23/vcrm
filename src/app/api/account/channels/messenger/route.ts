// ============================================================
// /api/account/channels/messenger
//
//   GET    — connection status. Any member can read. Never returns
//            the token, only { connected, page_name, connected_at,
//            needs_reauth, status }.
//   DELETE — disconnect. Admin+.
// ============================================================
import { NextResponse } from 'next/server'

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import type { MessengerConnectionStatus } from '@/types'

export async function GET() {
  try {
    const ctx = await getCurrentAccount()

    const { data, error } = await ctx.supabase
      .from('messenger_config')
      .select('page_name, connected_at, needs_reauth, status')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (error) {
      console.error('[GET /api/account/channels/messenger] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load Messenger connection' }, { status: 500 })
    }

    const result: MessengerConnectionStatus = data
      ? {
          connected: true,
          page_name: data.page_name,
          connected_at: data.connected_at,
          needs_reauth: data.needs_reauth,
          status: data.status,
        }
      : { connected: false, needs_reauth: false, status: 'disconnected' }

    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE() {
  try {
    const ctx = await requireRole('admin')

    const { error } = await ctx.supabase
      .from('messenger_config')
      .delete()
      .eq('account_id', ctx.accountId)

    if (error) {
      console.error('[DELETE /api/account/channels/messenger] delete error:', error)
      return NextResponse.json({ error: 'Failed to disconnect Messenger' }, { status: 500 })
    }

    return NextResponse.json({ disconnected: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
