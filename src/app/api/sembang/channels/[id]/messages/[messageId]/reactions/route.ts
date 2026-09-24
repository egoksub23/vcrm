// ============================================================
// /api/sembang/channels/[id]/messages/[messageId]/reactions
//
//   POST — body `{ emoji: string }`. Toggle semantics: if the caller
//          already has that exact `(message_id, user_id, emoji)`
//          reaction, delete it; otherwise insert it. One request either
//          way — the client never has to guess POST vs DELETE. Returns
//          `{ reactions: SembangReactionSummary[] }`, the message's full
//          updated reaction list, so the client can just replace its
//          local state.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { groupReactions } from '@/lib/sembang/hydrate-messages'

const EMOJI_MAX = 32

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> },
) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId, messageId } = await params

    const payload = (await request.json().catch(() => null)) as { emoji?: unknown } | null
    const emoji = typeof payload?.emoji === 'string' ? payload.emoji.trim() : ''
    if (!emoji || emoji.length > EMOJI_MAX) {
      return NextResponse.json(
        { error: `emoji must be between 1 and ${EMOJI_MAX} characters` },
        { status: 400 },
      )
    }

    // Defense in depth: the URL's channelId isn't otherwise consulted
    // below (sembang_reactions has no channel_id column), so confirm the
    // message actually belongs to this channel before touching anything.
    const { data: messageRow, error: messageError } = await ctx.supabase
      .from('sembang_messages')
      .select('id')
      .eq('id', messageId)
      .eq('channel_id', channelId)
      .maybeSingle()

    if (messageError) {
      console.error('[POST .../reactions] message lookup error:', messageError)
      return NextResponse.json({ error: 'Failed to toggle reaction' }, { status: 500 })
    }
    if (!messageRow) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }

    const { data: existing, error: existingError } = await ctx.supabase
      .from('sembang_reactions')
      .select('message_id')
      .eq('message_id', messageId)
      .eq('user_id', ctx.userId)
      .eq('emoji', emoji)
      .maybeSingle()

    if (existingError) {
      console.error('[POST .../reactions] existence check error:', existingError)
      return NextResponse.json({ error: 'Failed to toggle reaction' }, { status: 500 })
    }

    if (existing) {
      const { error } = await ctx.supabase
        .from('sembang_reactions')
        .delete()
        .eq('message_id', messageId)
        .eq('user_id', ctx.userId)
        .eq('emoji', emoji)
      if (error) {
        console.error('[POST .../reactions] delete error:', error)
        return NextResponse.json({ error: 'Failed to remove reaction' }, { status: 500 })
      }
    } else {
      const { error } = await ctx.supabase.from('sembang_reactions').insert({
        message_id: messageId,
        account_id: ctx.accountId,
        user_id: ctx.userId,
        emoji,
      })
      if (error) {
        if (error.code === '42501') {
          return NextResponse.json(
            { error: 'You must be a member of this channel to react' },
            { status: 403 },
          )
        }
        console.error('[POST .../reactions] insert error:', error)
        return NextResponse.json({ error: 'Failed to add reaction' }, { status: 500 })
      }
    }

    const { data: reactionRows, error: fetchErr } = await ctx.supabase
      .from('sembang_reactions')
      .select('user_id, emoji')
      .eq('message_id', messageId)

    if (fetchErr) {
      console.error('[POST .../reactions] refetch error:', fetchErr)
      return NextResponse.json({ error: 'Failed to load reactions' }, { status: 500 })
    }

    const reactions = groupReactions(reactionRows ?? [], ctx.userId)
    return NextResponse.json({ reactions })
  } catch (err) {
    return toErrorResponse(err)
  }
}
