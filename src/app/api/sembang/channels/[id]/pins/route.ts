// ============================================================
// /api/sembang/channels/[id]/pins
//
//   GET — `{ pins: SembangPin[] }`, most recently pinned first. Each pin
//         is hydrated with its full `message` (reusing the shared
//         message hydration helper) and the pinner's `full_name` (joined
//         from `profiles`). A pin whose message no longer resolves (the
//         message row itself was hard-deleted somehow — shouldn't
//         normally happen, cascades handle the usual case) is silently
//         dropped rather than returned half-built.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { hydrateMessages, type SembangMessageRow } from '@/lib/sembang/hydrate-messages'
import type { SembangPin } from '@/types'

interface PinRow {
  channel_id: string
  message_id: string
  pinned_by: string
  pinned_at: string
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId } = await params

    const { data: pinRows, error } = await ctx.supabase
      .from('sembang_pins')
      .select('channel_id, message_id, pinned_by, pinned_at')
      .eq('channel_id', channelId)
      .order('pinned_at', { ascending: false })

    if (error) {
      console.error('[GET /api/sembang/channels/[id]/pins] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load pins' }, { status: 500 })
    }

    const rows = (pinRows ?? []) as PinRow[]
    if (rows.length === 0) {
      return NextResponse.json({ pins: [] })
    }

    const messageIds = Array.from(new Set(rows.map((p) => p.message_id)))
    const { data: messageRows, error: msgErr } = await ctx.supabase
      .from('sembang_messages')
      .select('*')
      .in('id', messageIds)

    if (msgErr) {
      console.error('[GET /api/sembang/channels/[id]/pins] message fetch error:', msgErr)
      return NextResponse.json({ error: 'Failed to load pins' }, { status: 500 })
    }

    const hydratedMessages = await hydrateMessages(
      ctx.supabase,
      (messageRows ?? []) as SembangMessageRow[],
      ctx.userId,
    )
    const messageById = new Map(hydratedMessages.map((m) => [m.id, m]))

    const pinnerIds = Array.from(new Set(rows.map((p) => p.pinned_by)))
    const { data: profileRows } = await ctx.supabase
      .from('profiles')
      .select('user_id, full_name')
      .in('user_id', pinnerIds)
    const nameByUser = new Map<string, string>()
    for (const p of profileRows ?? []) nameByUser.set(p.user_id, p.full_name ?? '')

    const pins: SembangPin[] = rows
      .map((p): SembangPin | null => {
        const message = messageById.get(p.message_id)
        if (!message) return null
        return {
          channelId: p.channel_id,
          messageId: p.message_id,
          pinnedBy: p.pinned_by,
          pinnedByName: nameByUser.get(p.pinned_by) ?? '',
          pinnedAt: p.pinned_at,
          message,
        }
      })
      .filter((p): p is SembangPin => p !== null)

    return NextResponse.json({ pins })
  } catch (err) {
    return toErrorResponse(err)
  }
}
