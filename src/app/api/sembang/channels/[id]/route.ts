// ============================================================
// /api/sembang/channels/[id]
//
//   GET   — channel detail + the caller's memberRole (null if they can
//           see a public channel but have not joined it yet).
//   PATCH — body { topic?, archived?: boolean }. Update-eligibility is
//           entirely RLS's job (moderator/admin of this channel, or
//           account admin) — this route does not re-check role, it
//           just surfaces a 0-row update as 403.
//
// Both return `{ channel: SembangChannel }` (camelCase — see @/types).
// ============================================================
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import type { SembangChannel, SembangMemberRole } from '@/types'

const TOPIC_MAX = 2000

interface ChannelRow {
  id: string
  account_id: string
  name: string
  topic: string | null
  is_private: boolean
  created_by: string
  created_at: string
  archived_at: string | null
}

async function resolveMemberRole(
  supabase: SupabaseClient,
  channelId: string,
  userId: string,
): Promise<SembangMemberRole | null> {
  const { data } = await supabase
    .from('sembang_channel_members')
    .select('role')
    .eq('channel_id', channelId)
    .eq('user_id', userId)
    .maybeSingle()
  return (data?.role as SembangMemberRole | undefined) ?? null
}

function toChannel(row: ChannelRow, memberRole: SembangMemberRole | null): SembangChannel {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    topic: row.topic,
    isPrivate: row.is_private,
    createdBy: row.created_by,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    memberRole,
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId } = await params

    const { data: row, error } = await ctx.supabase
      .from('sembang_channels')
      .select('*')
      .eq('id', channelId)
      .maybeSingle()

    if (error) {
      console.error('[GET /api/sembang/channels/[id]] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load channel' }, { status: 500 })
    }
    if (!row) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
    }

    const memberRole = await resolveMemberRole(ctx.supabase, channelId, ctx.userId)

    return NextResponse.json({ channel: toChannel(row as ChannelRow, memberRole) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId } = await params

    const body = (await request.json().catch(() => null)) as {
      topic?: unknown
      archived?: unknown
    } | null

    const update: { topic?: string | null; archived_at?: string | null } = {}

    if (body?.topic !== undefined) {
      if (typeof body.topic !== 'string') {
        return NextResponse.json({ error: 'topic must be a string' }, { status: 400 })
      }
      const trimmed = body.topic.trim()
      if (trimmed.length > TOPIC_MAX) {
        return NextResponse.json({ error: 'Topic is too long' }, { status: 400 })
      }
      update.topic = trimmed || null
    }

    if (body?.archived !== undefined) {
      if (typeof body.archived !== 'boolean') {
        return NextResponse.json({ error: 'archived must be a boolean' }, { status: 400 })
      }
      update.archived_at = body.archived ? new Date().toISOString() : null
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    const { data: row, error } = await ctx.supabase
      .from('sembang_channels')
      .update(update)
      .eq('id', channelId)
      .select('*')
      .maybeSingle()

    if (error) {
      console.error('[PATCH /api/sembang/channels/[id]] update error:', error)
      return NextResponse.json({ error: 'Failed to update channel' }, { status: 500 })
    }
    if (!row) {
      // Either the channel does not exist, or RLS filtered the update
      // (caller is not a moderator/admin of this channel) — the update
      // policy's USING clause makes those indistinguishable here, and
      // 403 is the safer of the two to report.
      return NextResponse.json(
        { error: 'You do not have permission to update this channel' },
        { status: 403 },
      )
    }

    const memberRole = await resolveMemberRole(ctx.supabase, channelId, ctx.userId)

    return NextResponse.json({ channel: toChannel(row as ChannelRow, memberRole) })
  } catch (err) {
    return toErrorResponse(err)
  }
}
