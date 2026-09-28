// ============================================================
// /api/sembang/channels/[id]/tasks/[taskId]/assignees/[userId]
//
//   DELETE — removes one assignee. RLS-gated (any channel member); a
//            0-row delete is a normal 403.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; taskId: string; userId: string }> },
) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { taskId, userId } = await params

    const { data, error } = await ctx.supabase
      .from('sembang_task_assignees')
      .delete()
      .eq('task_id', taskId)
      .eq('user_id', userId)
      .select('user_id')
      .maybeSingle()

    if (error) {
      console.error('[DELETE .../tasks/[taskId]/assignees/[userId]] delete error:', error)
      return NextResponse.json({ error: 'Failed to remove that assignee' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json(
        { error: 'You do not have permission to unassign this task' },
        { status: 403 },
      )
    }

    return NextResponse.json({ removed: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
