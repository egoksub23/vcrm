// ============================================================
// /api/sembang/channels/[id]/mute
//
//   POST — body { muted: boolean }. Sets the CALLER's own mute state
//          for this channel/DM via the self-scoped
//          `set_sembang_channel_muted` RPC. There is no client UPDATE
//          policy on `sembang_channel_members` (same posture as role
//          changes / `last_read_at` bumps — see migration 098) so this
//          always goes through the RPC, never a direct table write.
//          The RPC silently no-ops for a channel the caller isn't a
//          member of — that's an acceptable response here too, not an
//          error, so this route does not verify membership first.
//
// Returns `{ muted: boolean }`.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId } = await params

    const body = (await request.json().catch(() => null)) as { muted?: unknown } | null
    if (typeof body?.muted !== 'boolean') {
      return NextResponse.json({ error: 'muted must be a boolean' }, { status: 400 })
    }
    const muted = body.muted

    const { error } = await ctx.supabase.rpc('set_sembang_channel_muted', {
      p_channel_id: channelId,
      p_muted: muted,
    })

    if (error) {
      console.error('[POST /api/sembang/channels/[id]/mute] rpc error:', error)
      return NextResponse.json({ error: 'Failed to update mute state' }, { status: 500 })
    }

    return NextResponse.json({ muted })
  } catch (err) {
    return toErrorResponse(err)
  }
}
