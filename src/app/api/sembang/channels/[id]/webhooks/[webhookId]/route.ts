// PATCH /api/sembang/channels/[id]/webhooks/[webhookId] — rename or toggle active
// DELETE /api/sembang/channels/[id]/webhooks/[webhookId] — delete a webhook
import { NextResponse } from 'next/server'
import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'

type Params = { id: string; webhookId: string }

async function requireModerator(ctx: Awaited<ReturnType<typeof requireCapability>>, channelId: string) {
  if (hasMinRole(ctx.role ?? 'viewer', 'admin')) return true
  const { data: member } = await ctx.supabase
    .from('sembang_members')
    .select('role')
    .eq('channel_id', channelId)
    .eq('user_id', ctx.userId)
    .eq('account_id', ctx.accountId)
    .single()
  return member?.role === 'moderator'
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<Params> },
) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId, webhookId } = await params

    if (!(await requireModerator(ctx, channelId))) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 })
    }

    const body = (await request.json().catch(() => null)) as {
      name?: unknown
      is_active?: unknown
    } | null

    const updates: Record<string, unknown> = {}
    if (typeof body?.name === 'string') updates.name = body.name.trim()
    if (typeof body?.is_active === 'boolean') updates.is_active = body.is_active

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
    }

    const { data, error } = await ctx.supabase
      .from('sembang_webhooks')
      .update(updates)
      .eq('id', webhookId)
      .eq('channel_id', channelId)
      .eq('account_id', ctx.accountId)
      .select('id, name, token, is_active, created_at, created_by')
      .single()

    if (error) {
      console.error('[PATCH /api/sembang/.../webhooks/[id]]', error.message)
      return NextResponse.json({ error: 'Failed to update webhook' }, { status: 500 })
    }

    return NextResponse.json({ webhook: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<Params> },
) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId, webhookId } = await params

    if (!(await requireModerator(ctx, channelId))) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 })
    }

    const { error } = await ctx.supabase
      .from('sembang_webhooks')
      .delete()
      .eq('id', webhookId)
      .eq('channel_id', channelId)
      .eq('account_id', ctx.accountId)

    if (error) {
      console.error('[DELETE /api/sembang/.../webhooks/[id]]', error.message)
      return NextResponse.json({ error: 'Failed to delete webhook' }, { status: 500 })
    }

    return new NextResponse(null, { status: 204 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
