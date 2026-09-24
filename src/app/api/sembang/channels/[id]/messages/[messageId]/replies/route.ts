// ============================================================
// /api/sembang/channels/[id]/messages/[messageId]/replies
//
//   GET — the full flat thread for a top-level message: `{ parent,
//         replies }`, both hydrated the same way as the main message
//         list (author, attachments, reactions). Replies are ascending
//         by `created_at`; `replyCount`/`lastReplyAt` are left undefined
//         on every row here (per the type's own doc comment — only the
//         top-level channel list computes those). No pagination — a
//         thread realistically won't have hundreds of replies in P1.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { hydrateMessages, type SembangMessageRow } from '@/lib/sembang/hydrate-messages'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> },
) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId, messageId } = await params

    const { data: parentRow, error: parentError } = await ctx.supabase
      .from('sembang_messages')
      .select('*')
      .eq('id', messageId)
      .eq('channel_id', channelId)
      .maybeSingle()

    if (parentError) {
      console.error('[GET .../messages/[messageId]/replies] parent fetch error:', parentError)
      return NextResponse.json({ error: 'Failed to load thread' }, { status: 500 })
    }
    if (!parentRow) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }

    const { data: replyRows, error } = await ctx.supabase
      .from('sembang_messages')
      .select('*')
      .eq('parent_message_id', messageId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })

    if (error) {
      console.error('[GET .../messages/[messageId]/replies] replies fetch error:', error)
      return NextResponse.json({ error: 'Failed to load thread' }, { status: 500 })
    }

    const rows = [parentRow, ...(replyRows ?? [])] as SembangMessageRow[]
    const [parent, ...replies] = await hydrateMessages(ctx.supabase, rows, ctx.userId)

    return NextResponse.json({ parent, replies })
  } catch (err) {
    return toErrorResponse(err)
  }
}
