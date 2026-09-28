// ============================================================
// /api/sembang/channels/[id]/tasks/[taskId]
//
//   GET    — `SembangTaskDetail` (`{task, subtasks, comments, activity}`)
//            — the one fetch TaskDetailDialog makes on open: the task itself plus its
//            full subtasks/comments/activity (unlike the list route's
//            hydrateTasks(), which only returns subtask *counts*).
//   PATCH  — body is a partial `{ title?, description?, dueAt?, status?,
//            ticketId? }`. Assignees are managed via the separate
//            `assignees` sub-route (§ below), not this PATCH.
//            `completedAt`/`completedBy` are never accepted from the
//            client, even if present in the body — the migration
//            099/121 trigger (`sembang_tasks_guard()`) stamps those
//            itself from the real actor when `status` flips. `status`
//            now accepts `'open' | 'in_progress' | 'done'` (migration
//            121). `ticketId` (migration 103) is write-once and
//            same-account-only, also enforced by that trigger — a second
//            attempt to set it, or a cross-account ticket id, comes back
//            as a 409 here rather than bubbling up the trigger's raw
//            exception. Returns the updated task, hydrated.
//   DELETE — RLS (`sembang_tasks_delete`) restricts this to the
//            creator, a moderator, or an admin — a 0-row delete is a
//            normal 403. Cascades remove the task's assignees/subtasks/
//            activity/comments (migration 121 FKs).
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { hydrateTasks, type SembangTaskRow } from '@/lib/sembang/hydrate-tasks'
import type {
  SembangSubtask,
  SembangTaskActivityEvent,
  SembangTaskActivityEventType,
  SembangTaskComment,
  SembangTaskDetail,
} from '@/types'

const TITLE_MAX = 500

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId, taskId } = await params

    const { data: row, error } = await ctx.supabase
      .from('sembang_tasks')
      .select('*')
      .eq('id', taskId)
      .eq('channel_id', channelId)
      .maybeSingle()

    if (error) {
      console.error('[GET /api/sembang/channels/[id]/tasks/[taskId]] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load task' }, { status: 500 })
    }
    if (!row) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    const [
      [task],
      { data: subtaskRows },
      { data: commentRows },
      { data: activityRows },
    ] = await Promise.all([
      hydrateTasks(ctx.supabase, [row as SembangTaskRow]),
      ctx.supabase.from('sembang_subtasks').select('*').eq('task_id', taskId).order('created_at', { ascending: true }),
      ctx.supabase.from('sembang_task_comments').select('*').eq('task_id', taskId).order('created_at', { ascending: true }),
      ctx.supabase.from('sembang_task_activity').select('*').eq('task_id', taskId).order('created_at', { ascending: true }),
    ])

    const personIds = Array.from(
      new Set([
        ...(subtaskRows ?? []).map((s) => s.assignee_id).filter((v): v is string => !!v),
        ...(commentRows ?? []).map((c) => c.author_id).filter((v): v is string => !!v),
        ...(activityRows ?? []).map((a) => a.actor_id).filter((v): v is string => !!v),
      ]),
    )
    const { data: profileRows } = personIds.length
      ? await ctx.supabase.from('profiles').select('user_id, full_name, avatar_url').in('user_id', personIds)
      : { data: [] }
    const profileByUser = new Map<string, { full_name: string | null; avatar_url: string | null }>()
    for (const p of profileRows ?? []) profileByUser.set(p.user_id, p)

    const subtasks: SembangSubtask[] = (subtaskRows ?? []).map((s) => ({
      id: s.id,
      taskId: s.task_id,
      title: s.title,
      status: s.status,
      assigneeId: s.assignee_id,
      assignee: s.assignee_id
        ? {
            id: s.assignee_id,
            fullName: profileByUser.get(s.assignee_id)?.full_name ?? '',
            avatarUrl: profileByUser.get(s.assignee_id)?.avatar_url ?? null,
          }
        : null,
      createdBy: s.created_by,
      createdAt: s.created_at,
      completedAt: s.completed_at,
      completedBy: s.completed_by,
    }))

    const comments: SembangTaskComment[] = (commentRows ?? []).map((c) => ({
      id: c.id,
      taskId: c.task_id,
      authorId: c.author_id,
      authorName: (c.author_id && profileByUser.get(c.author_id)?.full_name) || '',
      authorAvatarUrl: (c.author_id && profileByUser.get(c.author_id)?.avatar_url) || null,
      body: c.body,
      mentions: Array.isArray(c.mentions) ? c.mentions : [],
      createdAt: c.created_at,
      editedAt: c.edited_at,
    }))

    const activity: SembangTaskActivityEvent[] = (activityRows ?? []).map((a) => ({
      id: a.id,
      taskId: a.task_id,
      actorId: a.actor_id,
      actorName: (a.actor_id && profileByUser.get(a.actor_id)?.full_name) || '',
      eventType: a.event_type as SembangTaskActivityEventType,
      fromValue: a.from_value,
      toValue: a.to_value,
      createdAt: a.created_at,
    }))

    const detail: SembangTaskDetail = { task, subtasks, comments, activity }
    return NextResponse.json(detail)
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId, taskId } = await params

    const body = (await request.json().catch(() => null)) as {
      title?: unknown
      description?: unknown
      dueAt?: unknown
      status?: unknown
      ticketId?: unknown
    } | null

    // completedAt/completedBy are intentionally never read from `body`
    // here — even if a client sends them, they're ignored. The DB
    // trigger stamps both from the real actor when `status` transitions.
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

    if (body?.description !== undefined) {
      if (body.description !== null && typeof body.description !== 'string') {
        return NextResponse.json({ error: 'description must be a string or null' }, { status: 400 })
      }
      update.description = body.description === null ? null : body.description.trim() || null
    }

    if (body?.dueAt !== undefined) {
      if (body.dueAt === null) {
        update.due_at = null
      } else {
        if (typeof body.dueAt !== 'string') {
          return NextResponse.json({ error: 'dueAt must be a string or null' }, { status: 400 })
        }
        const dueDate = new Date(body.dueAt)
        if (Number.isNaN(dueDate.getTime())) {
          return NextResponse.json({ error: 'dueAt must be a valid ISO timestamp' }, { status: 400 })
        }
        update.due_at = dueDate.toISOString()
      }
    }

    if (body?.status !== undefined) {
      if (body.status !== 'open' && body.status !== 'in_progress' && body.status !== 'done') {
        return NextResponse.json(
          { error: "status must be 'open', 'in_progress', or 'done'" },
          { status: 400 },
        )
      }
      update.status = body.status
    }

    if (body?.ticketId !== undefined) {
      if (typeof body.ticketId !== 'string' || !body.ticketId) {
        return NextResponse.json({ error: 'ticketId must be a non-empty string' }, { status: 400 })
      }
      update.ticket_id = body.ticketId
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    const { data, error } = await ctx.supabase
      .from('sembang_tasks')
      .update(update)
      .eq('id', taskId)
      .eq('channel_id', channelId)
      .select('*')
      .maybeSingle()

    if (error) {
      // sembang_tasks_guard() (migration 103) rejects a second attempt to
      // set ticket_id, or one pointing at a ticket outside this account —
      // both surface here as a plain-message P0001 exception, not a
      // distinct SQLSTATE, so they're matched by message text.
      if (error.message?.includes('sembang_task_ticket_id_immutable_once_set')) {
        return NextResponse.json({ error: 'This task is already linked to a ticket' }, { status: 409 })
      }
      if (error.message?.includes('sembang_task_ticket_id_cross_account_or_missing')) {
        return NextResponse.json({ error: 'That ticket could not be linked' }, { status: 400 })
      }
      console.error('[PATCH /api/sembang/channels/[id]/tasks/[taskId]] update error:', error)
      return NextResponse.json({ error: 'Failed to update task' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json(
        { error: 'You do not have permission to update this task' },
        { status: 403 },
      )
    }

    const [task] = await hydrateTasks(ctx.supabase, [data as SembangTaskRow])
    return NextResponse.json({ task })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId, taskId } = await params

    const { data, error } = await ctx.supabase
      .from('sembang_tasks')
      .delete()
      .eq('id', taskId)
      .eq('channel_id', channelId)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[DELETE /api/sembang/channels/[id]/tasks/[taskId]] delete error:', error)
      return NextResponse.json({ error: 'Failed to delete task' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json(
        { error: 'You do not have permission to delete this task' },
        { status: 403 },
      )
    }

    return NextResponse.json({ deleted: true, id: data.id })
  } catch (err) {
    return toErrorResponse(err)
  }
}
