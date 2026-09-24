// ============================================================
// /api/sembang/channels/[id]/read
//
//   POST — mark the channel read for the caller, via the
//          `mark_sembang_channel_read` RPC. There is deliberately no
//          client UPDATE policy on `sembang_channel_members` (see
//          migration 098's comment) — this RPC is the only read-marking
//          path.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId } = await params

    const { error } = await ctx.supabase.rpc('mark_sembang_channel_read', {
      p_channel_id: channelId,
    })

    if (error) {
      console.error('[POST /api/sembang/channels/[id]/read] rpc error:', error)
      return NextResponse.json({ error: 'Failed to mark channel as read' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
