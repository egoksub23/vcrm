// ============================================================
// /api/sembang/channels/browse
//
//   GET — public (`is_private = false`), non-DM, non-archived channels
//         in the account that the caller is NOT already a member of
//         ("browse public channels", Slack's directory of joinable
//         channels). RLS (`sembang_channels_select`) already permits a
//         non-member to see any non-private channel row; the
//         not-already-a-member filter here is just to avoid re-listing
//         channels already in the sidebar, not a security boundary.
//         Member counts are batched with one `GROUP BY`-style query
//         (grouped in application code, same pattern
//         `hydrateMessages`'s own reply-count aggregation uses), not
//         N+1.
//
//         No join/POST route here — joining a public channel already
//         works via the EXISTING `POST /api/sembang/channels/[id]/members`
//         with `{ userIds: [callerId] }` (the self-insert RLS branch
//         already allows this for a non-private channel, and that route
//         has no app-layer moderator-only gate on top of RLS to work
//         around — see its own file).
//
// Returns `{ channels: SembangBrowseChannel[] }`.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import type { SembangBrowseChannel } from '@/types'

interface BrowseChannelRow {
  id: string
  name: string | null
  topic: string | null
}

export async function GET() {
  try {
    const ctx = await requireCapability('menu.sembang')

    // The caller's own membership ids, to exclude below — cheaper and
    // simpler than a `NOT EXISTS` subquery via PostgREST's query builder.
    const { data: myMemberRows, error: myMemberErr } = await ctx.supabase
      .from('sembang_channel_members')
      .select('channel_id')
      .eq('user_id', ctx.userId)

    if (myMemberErr) {
      console.error('[GET /api/sembang/channels/browse] membership fetch error:', myMemberErr)
      return NextResponse.json({ error: 'Failed to load channels' }, { status: 500 })
    }

    const myChannelIds = new Set((myMemberRows ?? []).map((m) => m.channel_id as string))

    const { data: channelRows, error } = await ctx.supabase
      .from('sembang_channels')
      .select('id, name, topic')
      .eq('account_id', ctx.accountId)
      .eq('is_private', false)
      .eq('is_dm', false)
      .is('archived_at', null)
      .order('name', { ascending: true })

    if (error) {
      console.error('[GET /api/sembang/channels/browse] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load channels' }, { status: 500 })
    }

    // Excluding channels the caller already belongs to is filtered here
    // in application code rather than a `NOT IN (...)` clause — simpler
    // than hand-building a PostgREST list-filter string, and this isn't
    // a security boundary (RLS already permits a non-member to see any
    // non-private channel row) so there's no correctness cost to doing
    // it client-side-of-the-query.
    const rows = ((channelRows ?? []) as BrowseChannelRow[]).filter((r) => !myChannelIds.has(r.id))
    if (rows.length === 0) {
      return NextResponse.json({ channels: [] })
    }

    const channelIds = rows.map((r) => r.id)
    const { data: memberRows, error: memberErr } = await ctx.supabase
      .from('sembang_channel_members')
      .select('channel_id')
      .in('channel_id', channelIds)

    if (memberErr) {
      console.error('[GET /api/sembang/channels/browse] member-count fetch error:', memberErr)
      return NextResponse.json({ error: 'Failed to load channels' }, { status: 500 })
    }

    const countByChannel = new Map<string, number>()
    for (const m of memberRows ?? []) {
      const id = m.channel_id as string
      countByChannel.set(id, (countByChannel.get(id) ?? 0) + 1)
    }

    const channels: SembangBrowseChannel[] = rows.map((r) => ({
      id: r.id,
      name: r.name ?? '',
      topic: r.topic,
      memberCount: countByChannel.get(r.id) ?? 0,
    }))

    return NextResponse.json({ channels })
  } catch (err) {
    return toErrorResponse(err)
  }
}
