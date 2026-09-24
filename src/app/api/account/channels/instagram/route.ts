// ============================================================
// /api/account/channels/instagram
//   GET — connection status. PUT — set webhook verify token (admin+,
//   write-only). PATCH — pause/resume, { enabled } (migration 097,
//   admin+, leaves the token untouched). DELETE — disconnect (admin+).
// Same shape as the Messenger route, plus ig_username.
// ============================================================
import { NextResponse } from 'next/server'

import { getCurrentAccount, requireCapability, toErrorResponse } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'
import type { InstagramConnectionStatus } from '@/types'

export async function GET() {
  try {
    const ctx = await getCurrentAccount()

    const { data, error } = await ctx.supabase
      .from('instagram_config')
      .select('ig_username, connected_at, needs_reauth, status, comments_enabled_at, enabled')
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
          comments_enabled_at: data.comments_enabled_at,
          enabled: data.enabled,
        }
      : { connected: false, needs_reauth: false, status: 'disconnected' }

    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireCapability('channels.manage')
    const body = (await request.json().catch(() => null)) as { verify_token?: unknown } | null
    const verifyToken = typeof body?.verify_token === 'string' ? body.verify_token.trim() : ''
    if (!verifyToken) {
      return NextResponse.json({ error: 'verify_token is required' }, { status: 400 })
    }

    const { error } = await ctx.supabase
      .from('instagram_config')
      .update({ verify_token: encrypt(verifyToken) })
      .eq('account_id', ctx.accountId)

    if (error) {
      console.error('[PUT /api/account/channels/instagram] update error:', error)
      return NextResponse.json({ error: 'Failed to save verify token' }, { status: 500 })
    }

    return NextResponse.json({ saved: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE() {
  try {
    const ctx = await requireCapability('channels.manage')

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

export async function PATCH(request: Request) {
  try {
    const ctx = await requireCapability('channels.manage')
    const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null
    if (typeof body?.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 })
    }

    const { error } = await ctx.supabase
      .from('instagram_config')
      .update({ enabled: body.enabled })
      .eq('account_id', ctx.accountId)

    if (error) {
      console.error('[PATCH /api/account/channels/instagram] update error:', error)
      return NextResponse.json({ error: 'Failed to update Instagram' }, { status: 500 })
    }

    return NextResponse.json({ success: true, enabled: body.enabled })
  } catch (err) {
    return toErrorResponse(err)
  }
}
