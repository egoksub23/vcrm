// ============================================================
// /api/sembang/channels/[id]/messages/[messageId]
//
//   PATCH — soft-delete ("remove message"). No body. Sets
//           `deleted_at`/`deleted_by`. RLS already restricts this to a
//           moderator/admin of the channel (`sembang_messages_moderate`);
//           if the UPDATE affects 0 rows, that's a 403, not a silent
//           no-op. Editing/deleting one's own message is P1 — not here.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'

export async function PATCH(
  _request: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> },
) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId, messageId } = await params

    const { data, error } = await ctx.supabase
      .from('sembang_messages')
      .update({ deleted_at: new Date().toISOString(), deleted_by: ctx.userId })
      .eq('id', messageId)
      .eq('channel_id', channelId)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[PATCH /api/sembang/channels/[id]/messages/[messageId]] update error:', error)
      return NextResponse.json({ error: 'Failed to remove message' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json(
        { error: 'You do not have permission to remove this message' },
        { status: 403 },
      )
    }

    return NextResponse.json({ deleted: true, id: data.id })
  } catch (err) {
    return toErrorResponse(err)
  }
}
