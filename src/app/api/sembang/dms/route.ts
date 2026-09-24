// ============================================================
// /api/sembang/dms
//
//   POST — body `{ participantUserIds: string[] }` (the caller is added
//          automatically, not included in the body). Idempotent
//          "get or create": a DM is a `sembang_channels` row with
//          `is_dm = true`, `is_private = true`, `name = null`, and
//          `dm_key` = the sorted, comma-joined participant user-id list
//          (migration 100). Messaging a participant set you already have
//          a DM with just returns the existing channel — this is not an
//          error, it's the whole point of computing `dm_key` up front.
//
//          A unique index on `(account_id, dm_key) WHERE is_dm` means two
//          concurrent requests creating the same DM race: the loser's
//          INSERT throws a 23505, which is caught and turned into the
//          same SELECT the "already exists" path uses — not surfaced as
//          an error.
//
// Returns `{ channel: SembangChannel }`, same hydration shape as
// GET /api/sembang/channels/[id] (including the caller's own
// `memberRole`), with `isDm: true`, `name: null`.
// ============================================================
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { isUuid } from '@/lib/teams/team-ids'
import type { SembangChannel } from '@/types'

// "9 others + the caller = 10 total" — a group DM is still a DM, but
// there's no product need for it to scale like a channel. Not
// load-bearing; picked to be generous enough for a small team huddle
// without inviting a giant-group-chat use case this pass doesn't design for.
const MAX_OTHER_PARTICIPANTS = 9

interface ChannelRow {
  id: string
  account_id: string
  name: string | null
  topic: string | null
  is_private: boolean
  is_dm: boolean
  created_by: string
  created_at: string
  archived_at: string | null
}

async function selectExistingDm(
  supabase: SupabaseClient,
  accountId: string,
  dmKey: string,
): Promise<ChannelRow | null> {
  const { data, error } = await supabase
    .from('sembang_channels')
    .select('*')
    .eq('account_id', accountId)
    .eq('is_dm', true)
    .eq('dm_key', dmKey)
    .maybeSingle()

  if (error) {
    console.error('[POST /api/sembang/dms] existing-dm lookup error:', error)
    throw new Error('Failed to look up direct message')
  }
  return (data as ChannelRow | null) ?? null
}

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability('menu.sembang')

    const body = (await request.json().catch(() => null)) as {
      participantUserIds?: unknown
    } | null

    if (!Array.isArray(body?.participantUserIds) || body.participantUserIds.length === 0) {
      return NextResponse.json(
        { error: 'participantUserIds must be a non-empty array' },
        { status: 400 },
      )
    }

    // Validate shape, dedupe, and drop the caller's own id if they sent it
    // (the route adds them implicitly — see the module doc comment).
    const otherIds: string[] = []
    const seen = new Set<string>()
    for (const raw of body.participantUserIds) {
      if (!isUuid(raw)) {
        return NextResponse.json(
          { error: 'participantUserIds must contain only valid ids' },
          { status: 400 },
        )
      }
      const id = raw.toLowerCase()
      if (id === ctx.userId.toLowerCase()) continue
      if (!seen.has(id)) {
        seen.add(id)
        otherIds.push(id)
      }
    }

    if (otherIds.length === 0) {
      return NextResponse.json(
        { error: 'Pick at least one other person to message' },
        { status: 400 },
      )
    }
    if (otherIds.length > MAX_OTHER_PARTICIPANTS) {
      return NextResponse.json(
        { error: `A direct message can include at most ${MAX_OTHER_PARTICIPANTS} other people` },
        { status: 400 },
      )
    }

    // Every remaining id must be a real profile in the caller's own
    // account — same account-membership check `create-channel-dialog.tsx`'s
    // invite flow relies on today.
    const { data: profileRows, error: profileErr } = await ctx.supabase
      .from('profiles')
      .select('user_id')
      .eq('account_id', ctx.accountId)
      .in('user_id', otherIds)

    if (profileErr) {
      console.error('[POST /api/sembang/dms] profile lookup error:', profileErr)
      return NextResponse.json({ error: 'Failed to validate participants' }, { status: 500 })
    }

    const validIds = new Set((profileRows ?? []).map((p) => p.user_id as string))
    const invalidIds = otherIds.filter((id) => !validIds.has(id))
    if (invalidIds.length > 0) {
      return NextResponse.json(
        { error: 'One or more selected people are not part of this account' },
        { status: 400 },
      )
    }

    const dmKey = [...otherIds, ctx.userId].sort().join(',')

    let channelRow = await selectExistingDm(ctx.supabase, ctx.accountId, dmKey)
    let created = false

    if (!channelRow) {
      const { data: insertedRow, error: insertErr } = await ctx.supabase
        .from('sembang_channels')
        .insert({
          account_id: ctx.accountId,
          is_private: true,
          is_dm: true,
          dm_key: dmKey,
          created_by: ctx.userId,
        })
        .select('*')
        .single()

      if (insertErr) {
        if (insertErr.code === '23505') {
          // Lost the race to a concurrent create — this IS the
          // idempotent-recovery path, not an error.
          channelRow = await selectExistingDm(ctx.supabase, ctx.accountId, dmKey)
          if (!channelRow) {
            console.error(
              '[POST /api/sembang/dms] 23505 but no row found on re-select:',
              insertErr,
            )
            return NextResponse.json({ error: 'Failed to create direct message' }, { status: 500 })
          }
        } else {
          console.error('[POST /api/sembang/dms] insert error:', insertErr)
          return NextResponse.json({ error: 'Failed to create direct message' }, { status: 500 })
        }
      } else {
        channelRow = insertedRow as ChannelRow
        created = true

        // The DB trigger already added the caller as moderator. Add the
        // other participants one at a time — same pattern as
        // `channels/[id]/members/route.ts` POST — so one duplicate/denied
        // insert doesn't abort the whole batch.
        for (const userId of otherIds) {
          const { error: memberErr } = await ctx.supabase.from('sembang_channel_members').insert({
            channel_id: channelRow.id,
            account_id: ctx.accountId,
            user_id: userId,
            role: 'member',
          })
          if (memberErr && memberErr.code !== '23505') {
            console.error('[POST /api/sembang/dms] member insert error:', memberErr)
          }
        }
      }
    }

    if (!channelRow) {
      // Unreachable in practice (every branch above either returns or
      // assigns a row) — kept as a type-narrowing guard for TS and a
      // defensive runtime fallback.
      return NextResponse.json({ error: 'Failed to create direct message' }, { status: 500 })
    }

    const { data: memberRow } = await ctx.supabase
      .from('sembang_channel_members')
      .select('role, muted')
      .eq('channel_id', channelRow.id)
      .eq('user_id', ctx.userId)
      .maybeSingle()

    const channel: SembangChannel = {
      id: channelRow.id,
      accountId: channelRow.account_id,
      name: channelRow.name,
      topic: channelRow.topic,
      isPrivate: channelRow.is_private,
      isDm: channelRow.is_dm,
      createdBy: channelRow.created_by,
      createdAt: channelRow.created_at,
      archivedAt: channelRow.archived_at,
      memberRole: (memberRow?.role as SembangChannel['memberRole']) ?? 'moderator',
      // Re-opening an existing DM (idempotent path) can have a real
      // prior mute state; a brand-new one is never muted.
      muted: memberRow?.muted ?? false,
    }

    return NextResponse.json({ channel }, { status: created ? 201 : 200 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
