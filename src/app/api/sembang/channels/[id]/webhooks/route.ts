// GET  /api/sembang/channels/[id]/webhooks — list webhooks for a channel
// POST /api/sembang/channels/[id]/webhooks — create a webhook
//
// Only channel moderators / account admins can manage webhooks.
// The token is generated server-side (crypto.randomUUID is enough —
// it's 128-bit random, comparable to a 22-char Slack webhook token).
import { NextResponse } from 'next/server'
import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId } = await params

    const { data, error } = await ctx.supabase
      .from('sembang_webhooks')
      .select('id, name, token, is_active, created_at, created_by')
      .eq('channel_id', channelId)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[GET /api/sembang/channels/[id]/webhooks]', error.message)
      return NextResponse.json({ error: 'Failed to load webhooks' }, { status: 500 })
    }

    return NextResponse.json({ webhooks: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId } = await params

    // Only admins / moderators can create webhooks
    if (!hasMinRole(ctx.role ?? 'viewer', 'admin')) {
      // Check channel role too
      const { data: member } = await ctx.supabase
        .from('sembang_members')
        .select('role')
        .eq('channel_id', channelId)
        .eq('user_id', ctx.userId)
        .eq('account_id', ctx.accountId)
        .single()

      if (!member || member.role !== 'moderator') {
        return NextResponse.json({ error: 'Only channel moderators can create webhooks' }, { status: 403 })
      }
    }

    const body = (await request.json().catch(() => null)) as { name?: unknown } | null
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }

    const token = crypto.randomUUID().replace(/-/g, '')

    const { data, error } = await ctx.supabase
      .from('sembang_webhooks')
      .insert({
        account_id: ctx.accountId,
        channel_id: channelId,
        name,
        token,
        created_by: ctx.userId,
      })
      .select('id, name, token, is_active, created_at, created_by')
      .single()

    if (error) {
      console.error('[POST /api/sembang/channels/[id]/webhooks]', error.message)
      return NextResponse.json({ error: 'Failed to create webhook' }, { status: 500 })
    }

    return NextResponse.json({ webhook: data }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
