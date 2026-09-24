// ============================================================
// /api/sembang/channels/[id]/members/[userId]
//
//   DELETE — leave (self) or remove (moderator/admin). RLS
//            (`sembang_channel_members_delete`) allows either; a 0-row
//            delete (not a member, or caller lacks permission to remove
//            someone else) is reported as 403.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId, userId } = await params

    const { data, error } = await ctx.supabase
      .from('sembang_channel_members')
      .delete()
      .eq('channel_id', channelId)
      .eq('user_id', userId)
      .select('user_id')
      .maybeSingle()

    if (error) {
      console.error('[DELETE /api/sembang/channels/[id]/members/[userId]] delete error:', error)
      return NextResponse.json({ error: 'Failed to remove member' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json(
        { error: 'You do not have permission to remove this member' },
        { status: 403 },
      )
    }

    return NextResponse.json({ removed: true, userId: data.user_id })
  } catch (err) {
    return toErrorResponse(err)
  }
}
