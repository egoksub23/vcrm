// ============================================================
// /api/sembang/search
//
//   GET — cross-channel/DM message search. `?q=<text>&limit=` (limit
//         default 30, max 100; 400 if `q` trimmed is under 2 chars).
//         Same ILIKE pattern as the existing per-channel `?q=` search
//         (`channels/[id]/messages/route.ts` GET), just without the
//         `channel_id` filter — `account_id = ctx.accountId` is defense
//         in depth, RLS (`sembang_messages_select`) already restricts
//         results to channels/DMs the caller can actually see.
//
// Returns `{ results: SembangSearchResult[] }` — each hydrated message
// (via the shared `hydrateMessages()` helper, so `starredByMe` comes
// along for free) plus its channel's `{ id, name, isDm, dmParticipantNames }`,
// batched (one follow-up query for all result channel ids), not N+1.
// ============================================================
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { hydrateMessages, type SembangMessageRow } from '@/lib/sembang/hydrate-messages'
import type { SembangSearchResult } from '@/types'

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100
const MIN_QUERY_LENGTH = 2

interface ChannelContextRow {
  id: string
  name: string | null
  is_dm: boolean
}

/** Resolves `{id, name, isDm, dmParticipantNames}` for a batch of channel
 *  ids, one follow-up query for the channels and (only if any are DMs)
 *  one more for their non-caller participants' names. Shared shape between
 *  `/api/sembang/search` and `/api/sembang/stars`. */
async function loadChannelContexts(
  supabase: SupabaseClient,
  channelIds: string[],
  callerUserId: string,
): Promise<Map<string, SembangSearchResult['channel']>> {
  const contexts = new Map<string, SembangSearchResult['channel']>()
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

export async function GET(request: Request) {
  try {
    const ctx = await requireCapability('menu.sembang')

    const url = new URL(request.url)
    const q = url.searchParams.get('q')?.trim() ?? ''
    if (q.length < MIN_QUERY_LENGTH) {
      return NextResponse.json(
        { error: `q must be at least ${MIN_QUERY_LENGTH} characters` },
        { status: 400 },
      )
    }

    const limitParam = Number(url.searchParams.get('limit'))
    const limit = Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(Math.trunc(limitParam), MAX_LIMIT)
      : DEFAULT_LIMIT

    const { data, error } = await ctx.supabase
      .from('sembang_messages')
      .select('*')
      .eq('account_id', ctx.accountId)
      .is('deleted_at', null)
      .ilike('body', `%${q}%`)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) {
      console.error('[GET /api/sembang/search] search error:', error)
      return NextResponse.json({ error: 'Failed to search messages' }, { status: 500 })
    }

    const rows = (data ?? []) as SembangMessageRow[]
    const [messages, channelContexts] = await Promise.all([
      hydrateMessages(ctx.supabase, rows, ctx.userId),
      loadChannelContexts(
        ctx.supabase,
        Array.from(new Set(rows.map((r) => r.channel_id))),
        ctx.userId,
      ),
    ])

    const messageById = new Map(messages.map((m) => [m.id, m]))

    const results: SembangSearchResult[] = rows
      .map((row): SembangSearchResult | null => {
        const message = messageById.get(row.id)
        const channel = channelContexts.get(row.channel_id)
        if (!message || !channel) return null
        return { message, channel }
      })
      .filter((r): r is SembangSearchResult => r !== null)

    return NextResponse.json({ results })
  } catch (err) {
    return toErrorResponse(err)
  }
}
