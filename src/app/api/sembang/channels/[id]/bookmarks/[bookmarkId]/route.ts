// ============================================================
// /api/sembang/channels/[id]/bookmarks/[bookmarkId]
//
//   DELETE — RLS (`sembang_bookmarks_delete`) restricts this to the
//            adder, a moderator, or an admin — a 0-row delete is a
//            normal 403, same pattern as the pin/task delete routes.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; bookmarkId: string }> },
) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId, bookmarkId } = await params

    const { data, error } = await ctx.supabase
      .from('sembang_bookmarks')
      .delete()
      .eq('id', bookmarkId)
      .eq('channel_id', channelId)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[DELETE /api/sembang/channels/[id]/bookmarks/[bookmarkId]] delete error:', error)
      return NextResponse.json({ error: 'Failed to remove bookmark' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json(
        { error: 'You do not have permission to remove this bookmark' },
        { status: 403 },
      )
    }

    return NextResponse.json({ deleted: true, id: data.id })
  } catch (err) {
    return toErrorResponse(err)
  }
}
