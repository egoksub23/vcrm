// ============================================================
// /api/account/channels/tiktok
//
//   GET    — connection status (any member). Never returns a token.
//   DELETE — disconnect (admin).
// ============================================================
import { NextResponse } from 'next/server'

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getOAuthBaseUrl } from '@/lib/meta/oauth'
import { tiktokConfigured } from '@/lib/comments/tiktok/api'

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const { data, error } = await ctx.supabase
      .from('tiktok_config')
      .select('display_name, username, connected_at, needs_reauth, status, webhook_registered_at, last_synced_at, refresh_expires_at')
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
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE() {
  try {
    const ctx = await requireRole('admin')
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
