// ============================================================
// /api/sembang/threads
//
//   GET — the caller's global "Threads you're in" view: every
//         thread-starting (top-level) message, across every channel/DM
//         the caller belongs to, where the caller (a) authored it, OR
//         (b) has replied to it, OR (c) was @mentioned in it or in one
//         of its replies (a mention inside a reply still surfaces the
//         THREAD, same as Slack). RLS already scopes every query below
//         to channels/DMs the caller can see — no manual membership
//         re-check needed. Built as three small id-collecting queries
//         + one final fetch, not one giant join.
//
// Returns `{ results: SembangThreadSummary[] }`, sorted by
// `lastReplyAt ?? createdAt` descending, capped at 50 (not paginated
// in P3).
// ============================================================
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { hydrateMessages, type SembangMessageRow } from '@/lib/sembang/hydrate-messages'
import type { SembangThreadSummary } from '@/types'

const RESULT_LIMIT = 50

interface ChannelContextRow {
  id: string
  name: string | null
  is_dm: boolean
}

/** Resolves `{id, name, isDm, dmParticipantNames}` for a batch of channel
 *  ids, one follow-up query for the channels and (only if any are DMs)
 *  one more for their non-caller participants' names. Same shape as the
 *  identically-named helper in `/api/sembang/search` and `/api/sembang/stars`
 *  — kept local rather than shared, matching this codebase's per-route
 *  convention. */
async function loadChannelContexts(
  supabase: SupabaseClient,
  channelIds: string[],
  callerUserId: string,
): Promise<Map<string, SembangThreadSummary['channel']>> {
  const contexts = new Map<string, SembangThreadSummary['channel']>()
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

    const [authoredRes, repliedRes, mentionedRes] = await Promise.all([
      // 1. Top-level messages the caller authored.
      ctx.supabase
        .from('sembang_messages')
        .select('id')
        .eq('author_id', ctx.userId)
        .is('parent_message_id', null)
        .is('deleted_at', null),
      // 2. Top-level ids the caller has replied to.
      ctx.supabase
        .from('sembang_messages')
        .select('parent_message_id')
        .eq('author_id', ctx.userId)
        .not('parent_message_id', 'is', null)
        .is('deleted_at', null),
      // 3. Any message (top-level OR reply) that @mentions the caller —
      //    a reply resolves up to ITS `parent_message_id` below.
      ctx.supabase
        .from('sembang_messages')
        .select('id, parent_message_id')
        .contains('mentions', [ctx.userId])
        .is('deleted_at', null),
    ])

    if (authoredRes.error || repliedRes.error || mentionedRes.error) {
      console.error(
        '[GET /api/sembang/threads] id-collection error:',
        authoredRes.error ?? repliedRes.error ?? mentionedRes.error,
      )
      return NextResponse.json({ error: 'Failed to load threads' }, { status: 500 })
    }

    const threadIds = new Set<string>()
    for (const r of authoredRes.data ?? []) threadIds.add(r.id as string)
    for (const r of repliedRes.data ?? []) {
      if (r.parent_message_id) threadIds.add(r.parent_message_id as string)
    }
    for (const r of mentionedRes.data ?? []) {
      threadIds.add((r.parent_message_id as string | null) ?? (r.id as string))
    }

    if (threadIds.size === 0) {
      return NextResponse.json({ results: [] })
    }

    // Re-fetch as top-level, non-deleted rows only — a thread whose OWN
    // top-level message was deleted has nothing sensible to show, skip it.
    const { data: messageRows, error: msgErr } = await ctx.supabase
      .from('sembang_messages')
      .select('*')
      .in('id', Array.from(threadIds))
      .is('parent_message_id', null)
      .is('deleted_at', null)

    if (msgErr) {
      console.error('[GET /api/sembang/threads] message fetch error:', msgErr)
      return NextResponse.json({ error: 'Failed to load threads' }, { status: 500 })
    }

    const rows = (messageRows ?? []) as SembangMessageRow[]
    if (rows.length === 0) {
      return NextResponse.json({ results: [] })
    }

    const [messages, channelContexts] = await Promise.all([
      hydrateMessages(ctx.supabase, rows, ctx.userId),
      loadChannelContexts(ctx.supabase, Array.from(new Set(rows.map((r) => r.channel_id))), ctx.userId),
    ])

    const results: SembangThreadSummary[] = messages
      .map((message): SembangThreadSummary | null => {
        const channel = channelContexts.get(message.channelId)
        if (!channel) return null
        return { message, channel }
      })
      .filter((r): r is SembangThreadSummary => r !== null)
      .sort((a, b) => {
        const aKey = a.message.lastReplyAt ?? a.message.createdAt
        const bKey = b.message.lastReplyAt ?? b.message.createdAt
        return bKey.localeCompare(aKey)
      })
      .slice(0, RESULT_LIMIT)

    return NextResponse.json({ results })
  } catch (err) {
    return toErrorResponse(err)
  }
}
