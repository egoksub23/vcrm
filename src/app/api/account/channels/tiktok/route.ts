// ============================================================
// /api/account/channels/tiktok
//
//   GET    — connection status (any member). Never returns a token.
//   PATCH  — pause/resume, { enabled } (migration 097, admin, leaves
//            the token untouched).
//   DELETE — disconnect (admin).
// ============================================================
import { NextResponse } from 'next/server'

import { getCurrentAccount, requireCapability, toErrorResponse } from '@/lib/auth/account'
import { getOAuthBaseUrl } from '@/lib/meta/oauth'
import { tiktokConfigured } from '@/lib/comments/tiktok/api'

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const { data, error } = await ctx.supabase
      .from('tiktok_config')
      .select('display_name, username, connected_at, needs_reauth, status, webhook_registered_at, last_synced_at, refresh_expires_at, enabled')
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (error) {
      console.error('[GET /api/account/channels/tiktok] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load the TikTok connection' }, { status: 500 })
    }

    const base = getOAuthBaseUrl(request)
    return NextResponse.json({
      app_configured: tiktokConfigured(),
      connected: !!data,
      display_name: data?.display_name ?? null,
      username: data?.username ?? null,
      connected_at: data?.connected_at ?? null,
      needs_reauth: data?.needs_reauth ?? false,
      status: data?.status ?? 'disconnected',
      webhook_registered_at: data?.webhook_registered_at ?? null,
      last_synced_at: data?.last_synced_at ?? null,
      redirect_uri: `${base}/api/account/channels/tiktok/oauth/callback/`,
      webhook_url: `${base}/api/tiktok/webhook`,
      enabled: data?.enabled ?? true,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE() {
  try {
    const ctx = await requireCapability('channels.manage')
    const { error } = await ctx.supabase.from('tiktok_config').delete().eq('account_id', ctx.accountId)
    if (error) {
      console.error('[DELETE /api/account/channels/tiktok] delete error:', error)
      return NextResponse.json({ error: 'Failed to disconnect TikTok' }, { status: 500 })
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
      .from('tiktok_config')
      .update({ enabled: body.enabled })
      .eq('account_id', ctx.accountId)

    if (error) {
      console.error('[PATCH /api/account/channels/tiktok] update error:', error)
      return NextResponse.json({ error: 'Failed to update TikTok' }, { status: 500 })
    }

    return NextResponse.json({ success: true, enabled: body.enabled })
  } catch (err) {
    return toErrorResponse(err)
  }
}
