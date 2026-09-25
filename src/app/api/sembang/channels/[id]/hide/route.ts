// ============================================================
// /api/sembang/channels/[id]/hide
//
//   POST — body { hidden: boolean }. Sets the CALLER's own "removed from
//          sidebar" state for this channel/DM via the self-scoped
//          `set_sembang_channel_hidden` RPC (migration 106) — same
//          posture as mute/read-marking: no client UPDATE policy on
//          `sembang_channel_members`, so this always goes through the
//          RPC. This never deletes the membership, the channel, or any
//          messages — it only stops list_sembang_channels_for_current_user
//          from returning this channel until a new message arrives or
//          the caller re-opens it (which marks it read, also un-hiding
//          it). The RPC silently no-ops for a channel the caller isn't a
//          member of — that's an acceptable response here too, not an
//          error, so this route does not verify membership first.
//
// Returns `{ hidden: boolean }`.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId } = await params

    const body = (await request.json().catch(() => null)) as { hidden?: unknown } | null
    if (typeof body?.hidden !== 'boolean') {
      return NextResponse.json({ error: 'hidden must be a boolean' }, { status: 400 })
    }
    const hidden = body.hidden

    const { error } = await ctx.supabase.rpc('set_sembang_channel_hidden', {
      p_channel_id: channelId,
      p_hidden: hidden,
    })

    if (error) {
      console.error('[POST /api/sembang/channels/[id]/hide] rpc error:', error)
      return NextResponse.json({ error: 'Failed to update' }, { status: 500 })
    }

    return NextResponse.json({ hidden })
  } catch (err) {
    return toErrorResponse(err)
  }
}
