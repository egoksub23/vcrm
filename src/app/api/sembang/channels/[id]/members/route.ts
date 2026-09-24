// ============================================================
// /api/sembang/channels/[id]/members
//
//   GET  — members with `profiles.full_name`/`avatar_url` joined, plus
//          `role`/`lastReadAt`. Any caller who can see the channel can
//          list its members (read policy mirrors `sembang_channels_select`).
//          Returns SembangMember[] (camelCase — see @/types).
//   POST — body { userIds: string[] }. Add people. RLS
//          (`sembang_channel_members_insert`) restricts this to a
//          moderator/admin, OR a self-insert into a public channel — a
//          call here to add SOMEONE ELSE will simply get a per-user
//          42501 back if the caller isn't a moderator/admin. Inserted
//          one at a time so one duplicate/denied user doesn't abort the
//          rest of the batch.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import type { SembangMember, SembangMemberRole } from '@/types'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId } = await params

    const { data: memberRows, error } = await ctx.supabase
      .from('sembang_channel_members')
      .select('user_id, role, joined_at, last_read_at')
      .eq('channel_id', channelId)
      .order('role', { ascending: false }) // 'moderator' sorts before 'member'
      .order('joined_at', { ascending: true })

    if (error) {
      console.error('[GET /api/sembang/channels/[id]/members] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load members' }, { status: 500 })
    }

    const userIds = (memberRows ?? []).map((m) => m.user_id)
    const profileByUser = new Map<string, { full_name: string | null; avatar_url: string | null }>()

    if (userIds.length > 0) {
      const { data: profileRows } = await ctx.supabase
        .from('profiles')
        .select('user_id, full_name, avatar_url')
        .in('user_id', userIds)
      for (const p of profileRows ?? []) profileByUser.set(p.user_id, p)
    }

    const members: SembangMember[] = (memberRows ?? []).map((m) => {
      const profile = profileByUser.get(m.user_id)
      return {
        userId: m.user_id,
        role: m.role as SembangMemberRole,
        joinedAt: m.joined_at,
        lastReadAt: m.last_read_at,
        fullName: profile?.full_name ?? '',
        avatarUrl: profile?.avatar_url ?? null,
      }
    })

    return NextResponse.json({ members })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId } = await params

    const body = (await request.json().catch(() => null)) as { userIds?: unknown } | null
    const userIds = Array.isArray(body?.userIds)
      ? Array.from(new Set(body.userIds.filter((v): v is string => typeof v === 'string')))
      : []

    if (userIds.length === 0) {
      return NextResponse.json({ error: 'userIds must be a non-empty array' }, { status: 400 })
    }

    const added: string[] = []
    const failed: { userId: string; error: string }[] = []

    for (const userId of userIds) {
      const { error } = await ctx.supabase.from('sembang_channel_members').insert({
        channel_id: channelId,
        account_id: ctx.accountId,
        user_id: userId,
        role: 'member',
      })

      if (error) {
        if (error.code === '23505') {
          failed.push({ userId, error: 'Already a member' })
        } else if (error.code === '42501') {
          failed.push({ userId, error: 'Not permitted to add this person' })
        } else {
          console.error('[POST /api/sembang/channels/[id]/members] insert error:', error)
          failed.push({ userId, error: 'Failed to add' })
        }
        continue
      }
      added.push(userId)
    }

    return NextResponse.json({ added, failed }, { status: failed.length > 0 && added.length === 0 ? 207 : 200 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
