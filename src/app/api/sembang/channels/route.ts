// ============================================================
// /api/sembang/channels
//
//   GET  — the caller's channel sidebar: calls
//          `list_sembang_channels_for_current_user`, which already does
//          the unread-count aggregation (migration 098) — do not
//          re-derive it here. Returns SembangChannelSummary[] (camelCase
//          — see @/types; the frontend's own type for this exact shape).
//   POST — create a channel. `menu.sembang` is enough (any member with
//          Sembang access may create a public or private channel — no
//          extra moderator gate); the creator becomes its moderator via
//          a DB trigger, not a second client insert. When `isPrivate`
//          and `inviteUserIds` are given, invited members are added in
//          a second insert (the trigger has already made the creator a
//          moderator by the time this runs, so RLS allows it).
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import type { SembangChannel, SembangChannelSummary, SembangMemberRole } from '@/types'

const NAME_MAX = 80
const TOPIC_MAX = 2000

interface ChannelSummaryRow {
  id: string
  name: string | null
  topic: string | null
  is_private: boolean
  created_by: string
  created_at: string
  member_role: SembangMemberRole
  last_read_at: string
  unread_count: number
  last_message_body: string | null
  last_message_at: string | null
  last_message_author_id: string | null
  // Migration 100.
  is_dm: boolean
  dm_participant_names: string[] | null
  dm_participant_avatar_urls: (string | null)[] | null
  // Migration 101.
  muted: boolean
}

export async function GET() {
  try {
    const ctx = await requireCapability('menu.sembang')

    const { data, error } = await ctx.supabase.rpc('list_sembang_channels_for_current_user', {
      p_account_id: ctx.accountId,
    })

    if (error) {
      console.error('[GET /api/sembang/channels] rpc error:', error)
      return NextResponse.json({ error: 'Failed to load channels' }, { status: 500 })
    }

    const channels: SembangChannelSummary[] = ((data ?? []) as ChannelSummaryRow[]).map((row) => ({
      id: row.id,
      name: row.name,
      topic: row.topic,
      isPrivate: row.is_private,
      createdBy: row.created_by,
      createdAt: row.created_at,
      memberRole: row.member_role,
      lastReadAt: row.last_read_at,
      unreadCount: Number(row.unread_count) || 0,
      lastMessageBody: row.last_message_body,
      lastMessageAt: row.last_message_at,
      lastMessageAuthorId: row.last_message_author_id,
      isDm: row.is_dm,
      dmParticipantNames: row.dm_participant_names,
      dmParticipantAvatarUrls: row.dm_participant_avatar_urls,
      muted: row.muted,
    }))

    return NextResponse.json({ channels })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability('menu.sembang')

    const body = (await request.json().catch(() => null)) as {
      name?: unknown
      topic?: unknown
      isPrivate?: unknown
      inviteUserIds?: unknown
    } | null

    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!name || name.length > NAME_MAX) {
      return NextResponse.json(
        { error: `Channel name must be between 1 and ${NAME_MAX} characters` },
        { status: 400 },
      )
    }

    let topic: string | null = null
    if (typeof body?.topic === 'string') {
      const trimmed = body.topic.trim()
      if (trimmed.length > TOPIC_MAX) {
        return NextResponse.json({ error: 'Topic is too long' }, { status: 400 })
      }
      topic = trimmed || null
    }

    if (typeof body?.isPrivate !== 'boolean') {
      return NextResponse.json({ error: 'isPrivate must be a boolean' }, { status: 400 })
    }
    const isPrivate = body.isPrivate

    const inviteUserIds = Array.isArray(body?.inviteUserIds)
      ? Array.from(new Set(body.inviteUserIds.filter((v): v is string => typeof v === 'string')))
      : []

    const { data: row, error } = await ctx.supabase
      .from('sembang_channels')
      .insert({
        account_id: ctx.accountId,
        name,
        topic,
        is_private: isPrivate,
        created_by: ctx.userId,
      })
      .select('*')
      .single()

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json(
          { error: 'A channel with this name already exists' },
          { status: 409 },
        )
      }
      if (error.code === '42501') {
        return NextResponse.json({ error: error.message }, { status: 403 })
      }
      console.error('[POST /api/sembang/channels] insert error:', error)
      return NextResponse.json({ error: 'Failed to create channel' }, { status: 500 })
    }

    // Invite people into a brand-new private channel. Public channels are
    // joinable on their own — invites are only meaningful for private
    // ones (see SPEC). The creator is already a moderator by now (DB
    // trigger), so `ignoreDuplicates` just quietly skips them if the
    // caller's invite list happened to include themselves.
    if (isPrivate && inviteUserIds.length > 0) {
      const { error: inviteErr } = await ctx.supabase.from('sembang_channel_members').upsert(
        inviteUserIds.map((userId) => ({
          channel_id: row.id as string,
          account_id: ctx.accountId,
          user_id: userId,
          role: 'member' as const,
        })),
        { onConflict: 'channel_id,user_id', ignoreDuplicates: true },
      )
      if (inviteErr) {
        // The channel itself was created successfully; a failed invite
        // batch is surfaced but not fatal — the moderator can add people
        // later from the members panel.
        console.error('[POST /api/sembang/channels] invite insert error:', inviteErr)
      }
    }

    const channel: SembangChannel = {
      id: row.id,
      accountId: row.account_id,
      name: row.name,
      topic: row.topic,
      isPrivate: row.is_private,
      isDm: false,
      createdBy: row.created_by,
      createdAt: row.created_at,
      archivedAt: row.archived_at,
      // The DB trigger (`sembang_add_creator_as_moderator`) always makes
      // the creator a moderator, synchronously within the same insert.
      memberRole: 'moderator',
      // A freshly created channel is never muted.
      muted: false,
    }

    return NextResponse.json({ channel }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
