// ============================================================
// /api/sembang/channels/[id]/tasks/[taskId]/assignees
//
//   POST — body `{ userId: string }`. Adds one assignee (granular, not a
//          bulk replace — see `sembang_task_assignees`, migration 121).
//          A duplicate add (already assigned) is a 409, not a 500 — the
//          table's PK (`task_id, user_id`) is what actually enforces
//          this, matched here by error code.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { taskId } = await params

    const body = (await request.json().catch(() => null)) as { userId?: unknown } | null
    const userId = typeof body?.userId === 'string' ? body.userId : ''
    if (!userId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400 })
    }

    const { error } = await ctx.supabase.from('sembang_task_assignees').insert({
      task_id: taskId,
      user_id: userId,
      account_id: ctx.accountId,
      added_by: ctx.userId,
    })

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ error: 'That person is already assigned' }, { status: 409 })
      }
      if (error.code === '42501') {
        return NextResponse.json(
          { error: 'You do not have permission to assign this task' },
          { status: 403 },
        )
      }
      console.error('[POST /api/sembang/channels/[id]/tasks/[taskId]/assignees] insert error:', error)
      return NextResponse.json({ error: 'Failed to assign that person' }, { status: 500 })
    }

    return NextResponse.json({ assigned: true }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
