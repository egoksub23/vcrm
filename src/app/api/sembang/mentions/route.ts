// ============================================================
// /api/sembang/mentions
//
//   GET — the caller's own unread `sembang_mention`/`sembang_dm_message`
//         notifications across every channel/DM, most recent first,
//         default/max 100. Hydrated with the underlying message (via
//         `hydrateMessages`, so `starredByMe` etc. come along for free)
//         and channel context, batched — same
//         `loadChannelContexts` shape as `/api/sembang/search` and
//         `/api/sembang/stars` (kept local, not shared, matching this
//         codebase's per-route convention).
//
//   "Mark as done" has no dedicated endpoint — the frontend writes
//   `notifications.read_at` directly via the Supabase client, the exact
//   mechanism the Notifications page already uses (RLS + a column-level
//   GRANT restrict this to the caller's own read_at, nothing new here).
//
// Returns `{ results: SembangMentionItem[] }`.
// ============================================================
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { hydrateMessages, type SembangMessageRow } from '@/lib/sembang/hydrate-messages'
import type { SembangMentionItem } from '@/types'

const DEFAULT_LIMIT = 100

interface NotificationRow {
  id: string
  created_at: string
  sembang_channel_id: string | null
  sembang_message_id: string | null
}

interface ChannelContextRow {
  id: string
  name: string | null
  is_dm: boolean
}

/** Resolves `{id, name, isDm, dmParticipantNames}` for a batch of channel
 *  ids — identical shape to the helper in `/api/sembang/stars` and
 *  `/api/sembang/search`. */
async function loadChannelContexts(
  supabase: SupabaseClient,
  channelIds: string[],
  callerUserId: string,
): Promise<Map<string, SembangMentionItem['channel']>> {
  const contexts = new Map<string, SembangMentionItem['channel']>()
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

    const { data: notifRows, error } = await ctx.supabase
      .from('notifications')
      .select('id, created_at, sembang_channel_id, sembang_message_id')
      .eq('user_id', ctx.userId)
      .in('type', ['sembang_mention', 'sembang_dm_message'])
      .is('read_at', null)
      .order('created_at', { ascending: false })
      .limit(DEFAULT_LIMIT)

    if (error) {
      console.error('[GET /api/sembang/mentions] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load mentions' }, { status: 500 })
    }

    const notifications = (notifRows ?? []) as NotificationRow[]
    if (notifications.length === 0) {
      return NextResponse.json({ results: [] })
    }

    const messageIds = Array.from(
      new Set(notifications.map((n) => n.sembang_message_id).filter((id): id is string => !!id)),
    )
    const channelIds = Array.from(
      new Set(notifications.map((n) => n.sembang_channel_id).filter((id): id is string => !!id)),
    )

    const { data: messageRows, error: msgErr } = await ctx.supabase
      .from('sembang_messages')
      .select('*')
      .in('id', messageIds.length > 0 ? messageIds : ['00000000-0000-0000-0000-000000000000'])

    if (msgErr) {
      console.error('[GET /api/sembang/mentions] message fetch error:', msgErr)
      return NextResponse.json({ error: 'Failed to load mentions' }, { status: 500 })
    }

    const [messages, channelContexts] = await Promise.all([
      hydrateMessages(ctx.supabase, (messageRows ?? []) as SembangMessageRow[], ctx.userId),
      loadChannelContexts(ctx.supabase, channelIds, ctx.userId),
    ])

    const messageById = new Map(messages.map((m) => [m.id, m]))

    // A notification whose channel no longer resolves (shouldn't normally
    // happen — sembang_channel_id cascades on delete) is dropped rather
    // than shown with no context to act on. A notification whose message
    // was deleted still shows (message: null) so "mark as done" clears
    // the stale entry.
    const results: SembangMentionItem[] = notifications
      .map((n): SembangMentionItem | null => {
        if (!n.sembang_channel_id) return null
        const channel = channelContexts.get(n.sembang_channel_id)
        if (!channel) return null
        return {
          notificationId: n.id,
          createdAt: n.created_at,
          message: n.sembang_message_id ? (messageById.get(n.sembang_message_id) ?? null) : null,
          channel,
        }
      })
      .filter((r): r is SembangMentionItem => r !== null)

    return NextResponse.json({ results })
  } catch (err) {
    return toErrorResponse(err)
  }
}
