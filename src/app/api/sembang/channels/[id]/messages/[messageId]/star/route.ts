// ============================================================
// /api/sembang/channels/[id]/messages/[messageId]/star
//
//   POST   — star the message for the caller (insert into
//            `sembang_stars`). Idempotent from the client's perspective:
//            a duplicate insert (already starred) is a 23505, treated as
//            success rather than an error.
//   DELETE — unstar it. No-op (not a 404) if it wasn't starred.
//
// Personal, not realtime-synced (migration 100 — `sembang_stars` isn't in
// the realtime publication) — the client updates its own state
// optimistically on toggle.
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

    // Defense in depth: confirm the message actually belongs to this
    // channel before touching anything (same lookup block as
    // .../reactions/route.ts).
    const { data: messageRow, error: messageError } = await ctx.supabase
      .from('sembang_messages')
      .select('id')
      .eq('id', messageId)
      .eq('channel_id', channelId)
      .maybeSingle()

    if (messageError) {
      console.error('[POST .../star] message lookup error:', messageError)
      return NextResponse.json({ error: 'Failed to star message' }, { status: 500 })
    }
    if (!messageRow) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }

    const { error } = await ctx.supabase.from('sembang_stars').insert({
      message_id: messageId,
      account_id: ctx.accountId,
      user_id: ctx.userId,
    })

    if (error && error.code !== '23505') {
      if (error.code === '42501') {
        return NextResponse.json(
          { error: 'You must be able to see this message to star it' },
          { status: 403 },
        )
      }
      console.error('[POST .../star] insert error:', error)
      return NextResponse.json({ error: 'Failed to star message' }, { status: 500 })
    }

    return NextResponse.json({ starred: true }, { status: 201 })
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

    const { data: messageRow, error: messageError } = await ctx.supabase
      .from('sembang_messages')
      .select('id')
      .eq('id', messageId)
      .eq('channel_id', channelId)
      .maybeSingle()

    if (messageError) {
      console.error('[DELETE .../star] message lookup error:', messageError)
      return NextResponse.json({ error: 'Failed to unstar message' }, { status: 500 })
    }
    if (!messageRow) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }

    const { error } = await ctx.supabase
      .from('sembang_stars')
      .delete()
      .eq('message_id', messageId)
      .eq('user_id', ctx.userId)

    if (error) {
      console.error('[DELETE .../star] delete error:', error)
      return NextResponse.json({ error: 'Failed to unstar message' }, { status: 500 })
    }

    return NextResponse.json({ starred: false })
  } catch (err) {
    return toErrorResponse(err)
  }
}
