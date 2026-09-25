// ============================================================
// /api/sembang/channels/[id]/tasks/[taskId]
//
//   PATCH  — body is a partial `{ title?, assigneeId?, dueAt?, status?,
//            ticketId? }`. `completedAt`/`completedBy` are never accepted
//            from the client, even if present in the body — the migration
//            099 trigger (`sembang_tasks_guard()`) stamps those itself
//            from the real actor when `status` flips. `ticketId`
//            (migration 103) is write-once and same-account-only, also
//            enforced by that trigger — a second attempt to set it, or a
//            cross-account ticket id, comes back as a 409 here rather
//            than bubbling up the trigger's raw exception. Returns the
//            updated task, hydrated.
//   DELETE — RLS (`sembang_tasks_delete`) restricts this to the
//            creator, a moderator, or an admin — a 0-row delete is a
//            normal 403.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { hydrateTasks, type SembangTaskRow } from '@/lib/sembang/hydrate-tasks'

const TITLE_MAX = 500

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId, taskId } = await params

    const body = (await request.json().catch(() => null)) as {
      title?: unknown
      assigneeId?: unknown
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

    if (body?.assigneeId !== undefined) {
      if (body.assigneeId !== null && typeof body.assigneeId !== 'string') {
        return NextResponse.json({ error: 'assigneeId must be a string or null' }, { status: 400 })
      }
      update.assignee_id = body.assigneeId
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
      if (body.status !== 'open' && body.status !== 'done') {
        return NextResponse.json({ error: "status must be 'open' or 'done'" }, { status: 400 })
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
