// ============================================================
// /api/sembang/stars
//
//   GET — the caller's own starred messages across every channel/DM
//         (`sembang_stars` where `user_id = ctx.userId`), most recently
//         starred first, default/max 100. Hydrated the same way as the
//         channel message list (`starredByMe` comes along for free) plus
//         each message's channel context, batched (one follow-up query
//         for all the distinct channel ids), not N+1 — same helper shape
//         as `/api/sembang/search`.
//
// Returns `{ results: SembangStarredMessage[] }`.
// ============================================================
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { hydrateMessages, type SembangMessageRow } from '@/lib/sembang/hydrate-messages'
import type { SembangStarredMessage } from '@/types'

const DEFAULT_LIMIT = 100

interface StarRow {
  message_id: string
  starred_at: string
}

interface ChannelContextRow {
  id: string
  name: string | null
  is_dm: boolean
}

/** Resolves `{id, name, isDm, dmParticipantNames}` for a batch of channel
 *  ids, one follow-up query for the channels and (only if any are DMs)
 *  one more for their non-caller participants' names. Same shape as the
 *  identically-named helper in `/api/sembang/search` — kept local rather
 *  than shared, matching this codebase's per-route convention. */
async function loadChannelContexts(
  supabase: SupabaseClient,
  channelIds: string[],
  callerUserId: string,
): Promise<Map<string, SembangStarredMessage['channel']>> {
  const contexts = new Map<string, SembangStarredMessage['channel']>()
  if (channelIds.length === 0) return contexts

  const { data: channelRows, error } = await supabase
    .from('sembang_channels')
    .select('id, name, is_dm')
    .in('id', channelIds)

  if (error) {
    console.error('[loadChannelContexts] channel fetch error:', error)
    return contexts
  }

  const rows = (channelRows ?? []) as ChannelContextRow[]
  const dmChannelIds = rows.filter((r) => r.is_dm).map((r) => r.id)

  const namesByChannel = new Map<string, string[]>()
  if (dmChannelIds.length > 0) {
    const { data: memberRows } = await supabase
      .from('sembang_channel_members')
      .select('channel_id, user_id')
      .in('channel_id', dmChannelIds)
      .neq('user_id', callerUserId)

    const otherUserIds = Array.from(new Set((memberRows ?? []).map((m) => m.user_id as string)))
    const nameByUser = new Map<string, string>()
    if (otherUserIds.length > 0) {
      const { data: profileRows } = await supabase
        .from('profiles')
        .select('user_id, full_name')
        .in('user_id', otherUserIds)
      for (const p of profileRows ?? []) nameByUser.set(p.user_id, p.full_name ?? '')
    }

    for (const m of memberRows ?? []) {
      const list = namesByChannel.get(m.channel_id) ?? []
      list.push(nameByUser.get(m.user_id) ?? '')
      namesByChannel.set(m.channel_id, list)
    }
  }

  for (const row of rows) {
    contexts.set(row.id, {
      id: row.id,
      name: row.name,
      isDm: row.is_dm,
      dmParticipantNames: row.is_dm ? namesByChannel.get(row.id) ?? [] : null,
    })
  }

  return contexts
}

export async function GET() {
  try {
    const ctx = await requireCapability('menu.sembang')

    const { data: starRows, error } = await ctx.supabase
      .from('sembang_stars')
      .select('message_id, starred_at')
      .eq('user_id', ctx.userId)
      .order('starred_at', { ascending: false })
      .limit(DEFAULT_LIMIT)

    if (error) {
      console.error('[GET /api/sembang/stars] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load starred messages' }, { status: 500 })
    }

    const stars = (starRows ?? []) as StarRow[]
    if (stars.length === 0) {
      return NextResponse.json({ results: [] })
    }

    const messageIds = Array.from(new Set(stars.map((s) => s.message_id)))
    const { data: messageRows, error: msgErr } = await ctx.supabase
      .from('sembang_messages')
      .select('*')
      .in('id', messageIds)

    if (msgErr) {
      console.error('[GET /api/sembang/stars] message fetch error:', msgErr)
      return NextResponse.json({ error: 'Failed to load starred messages' }, { status: 500 })
    }

    const rows = (messageRows ?? []) as SembangMessageRow[]
    const [messages, channelContexts] = await Promise.all([
      hydrateMessages(ctx.supabase, rows, ctx.userId),
      loadChannelContexts(
        ctx.supabase,
        Array.from(new Set(rows.map((r) => r.channel_id))),
        ctx.userId,
      ),
    ])

    const messageById = new Map(messages.map((m) => [m.id, m]))

    // Preserve `starred_at DESC` order — the message/channel-context
    // fetches above are unordered `.in()` lookups.
    const results: SembangStarredMessage[] = stars
      .map((s): SembangStarredMessage | null => {
        const message = messageById.get(s.message_id)
        if (!message) return null
        const channel = channelContexts.get(message.channelId)
        if (!channel) return null
        return { message, starredAt: s.starred_at, channel }
      })
      .filter((r): r is SembangStarredMessage => r !== null)

    return NextResponse.json({ results })
  } catch (err) {
    return toErrorResponse(err)
  }
}
