// ============================================================
// /api/sembang/channels/[id]/tasks/[taskId]/subtasks/[subtaskId]
//
//   PATCH  — body is a partial `{ title?, status?, assigneeId? }`.
//            `completedAt`/`completedBy` are trigger-stamped
//            (sembang_subtasks_guard(), migration 121), never accepted
//            from the client. Returns the updated subtask, hydrated.
//   DELETE — RLS restricts this to the subtask's creator, a channel
//            moderator, or a Sembang manager — a 0-row delete is a
//            normal 403.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import type { SembangSubtask } from '@/types'

const TITLE_MAX = 500

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; taskId: string; subtaskId: string }> },
) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { taskId, subtaskId } = await params

    const body = (await request.json().catch(() => null)) as {
      title?: unknown
      status?: unknown
      assigneeId?: unknown
    } | null

    const update: Record<string, unknown> = {}

    if (body?.title !== undefined) {
      if (typeof body.title !== 'string') {
        return NextResponse.json({ error: 'title must be a string' }, { status: 400 })
      }
      const trimmed = body.title.trim()
      if (!trimmed || trimmed.length > TITLE_MAX) {
        return NextResponse.json(
          { error: `Title must be between 1 and ${TITLE_MAX} characters` },
          { status: 400 },
        )
      }
      update.title = trimmed
    }

    if (body?.status !== undefined) {
      if (body.status !== 'open' && body.status !== 'done') {
        return NextResponse.json({ error: "status must be 'open' or 'done'" }, { status: 400 })
      }
      update.status = body.status
    }

    if (body?.assigneeId !== undefined) {
      if (body.assigneeId !== null && typeof body.assigneeId !== 'string') {
        return NextResponse.json({ error: 'assigneeId must be a string or null' }, { status: 400 })
      }
      update.assignee_id = body.assigneeId
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    const { data, error } = await ctx.supabase
      .from('sembang_subtasks')
      .update(update)
      .eq('id', subtaskId)
      .eq('task_id', taskId)
      .select('*')
      .maybeSingle()

    if (error) {
      console.error('[PATCH .../subtasks/[subtaskId]] update error:', error)
      return NextResponse.json({ error: 'Failed to update subtask' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json(
        { error: 'You do not have permission to update this subtask' },
        { status: 403 },
      )
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
    return NextResponse.json({ subtask })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; taskId: string; subtaskId: string }> },
) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { taskId, subtaskId } = await params

    const { data, error } = await ctx.supabase
      .from('sembang_subtasks')
      .delete()
      .eq('id', subtaskId)
      .eq('task_id', taskId)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[DELETE .../subtasks/[subtaskId]] delete error:', error)
      return NextResponse.json({ error: 'Failed to delete subtask' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json(
        { error: 'You do not have permission to delete this subtask' },
        { status: 403 },
      )
    }

    return NextResponse.json({ deleted: true, id: data.id })
  } catch (err) {
    return toErrorResponse(err)
  }
}
