// ============================================================
// /api/sembang/channels/[id]/messages/[messageId]/pin
//
//   POST   — pin the message (insert into `sembang_pins`,
//            `pinned_by = ctx.userId`). RLS requires actual channel
//            membership (`sembang_pins_insert`) — a 42501 here means
//            "you're not a member," surfaced as a friendly 403.
//   DELETE — unpin it. RLS (`sembang_pins_delete`) allows the original
//            pinner, a moderator, or an admin — anyone else gets a
//            0-row delete, reported as 403.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> },
) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId, messageId } = await params

    const { error } = await ctx.supabase.from('sembang_pins').insert({
      channel_id: channelId,
      message_id: messageId,
      account_id: ctx.accountId,
      pinned_by: ctx.userId,
    })

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ error: 'Message is already pinned' }, { status: 409 })
      }
      if (error.code === '42501') {
        return NextResponse.json(
          { error: 'You must be a member of this channel to pin messages' },
          { status: 403 },
        )
      }
      console.error('[POST .../pin] insert error:', error)
      return NextResponse.json({ error: 'Failed to pin message' }, { status: 500 })
    }

    return NextResponse.json({ pinned: true }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> },
) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId, messageId } = await params

    const { data, error } = await ctx.supabase
      .from('sembang_pins')
      .delete()
      .eq('channel_id', channelId)
      .eq('message_id', messageId)
      .select('message_id')
      .maybeSingle()

    if (error) {
      console.error('[DELETE .../pin] delete error:', error)
      return NextResponse.json({ error: 'Failed to unpin message' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json(
        { error: 'You do not have permission to unpin this message' },
        { status: 403 },
      )
    }

    return NextResponse.json({ unpinned: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
