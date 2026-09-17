// ============================================================
// /api/account/channels/instagram
//   GET    — connection status. DELETE — disconnect (admin+).
// Same shape as the Messenger route, plus ig_username.
// ============================================================
import { NextResponse } from 'next/server'

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import type { InstagramConnectionStatus } from '@/types'

export async function GET() {
  try {
    const ctx = await getCurrentAccount()

    const { data, error } = await ctx.supabase
      .from('instagram_config')
      .select('ig_username, connected_at, needs_reauth, status')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (error) {
      console.error('[GET /api/account/channels/instagram] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load Instagram connection' }, { status: 500 })
    }

    const result: InstagramConnectionStatus = data
      ? {
          connected: true,
          ig_username: data.ig_username,
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
      .from('instagram_config')
      .delete()
      .eq('account_id', ctx.accountId)

    if (error) {
      console.error('[DELETE /api/account/channels/instagram] delete error:', error)
      return NextResponse.json({ error: 'Failed to disconnect Instagram' }, { status: 500 })
    }

    return NextResponse.json({ disconnected: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
