// ============================================================
// /api/sembang/channels/[id]/tasks/[taskId]/subtasks
//
//   POST — body `{ title: string; assigneeId?: string }`. `created_by =
//          ctx.userId`, status starts `open`. Returns the created
//          subtask hydrated with the assignee's name/avatar.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import type { SembangSubtask } from '@/types'

const TITLE_MAX = 500

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { taskId } = await params

    const body = (await request.json().catch(() => null)) as {
      title?: unknown
      assigneeId?: unknown
    } | null

    const title = typeof body?.title === 'string' ? body.title.trim() : ''
    if (!title || title.length > TITLE_MAX) {
      return NextResponse.json(
        { error: `Title must be between 1 and ${TITLE_MAX} characters` },
        { status: 400 },
      )
    }
    const assigneeId = typeof body?.assigneeId === 'string' ? body.assigneeId : null

    const { data, error } = await ctx.supabase
      .from('sembang_subtasks')
      .insert({
        task_id: taskId,
        account_id: ctx.accountId,
        title,
        assignee_id: assigneeId,
        created_by: ctx.userId,
      })
      .select('*')
      .single()

    if (error) {
      if (error.code === '42501') {
        return NextResponse.json(
          { error: 'You do not have permission to add subtasks here' },
          { status: 403 },
        )
      }
      console.error('[POST .../tasks/[taskId]/subtasks] insert error:', error)
      return NextResponse.json({ error: 'Failed to add subtask' }, { status: 500 })
    }

    let assignee: SembangSubtask['assignee'] = null
    if (data.assignee_id) {
      const { data: profile } = await ctx.supabase
        .from('profiles')
        .select('full_name, avatar_url')
        .eq('user_id', data.assignee_id)
        .maybeSingle()
      assignee = { id: data.assignee_id, fullName: profile?.full_name ?? '', avatarUrl: profile?.avatar_url ?? null }
    }

    const subtask: SembangSubtask = {
      id: data.id,
      taskId: data.task_id,
      title: data.title,
      status: data.status,
      assigneeId: data.assignee_id,
      assignee,
      createdBy: data.created_by,
      createdAt: data.created_at,
      completedAt: data.completed_at,
      completedBy: data.completed_by,
    }
    return NextResponse.json({ subtask }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
