// ============================================================
// /api/sembang/channels/[id]/tasks
//
//   GET  — `{ tasks: SembangTask[] }`. Open tasks first (by `created_at`
//          ascending within status), then done tasks (most recently
//          completed first). Joins `profiles` for `assignee`/
//          `createdByName`.
//   POST — body `{ title: string; assigneeId?: string; dueAt?: string;
//          messageId?: string }`. `created_by = ctx.userId`, status
//          starts `open`. Returns the created task, hydrated.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { hydrateTasks, type SembangTaskRow } from '@/lib/sembang/hydrate-tasks'

const TITLE_MAX = 500

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId } = await params

    const { data, error } = await ctx.supabase
      .from('sembang_tasks')
      .select('*')
      .eq('channel_id', channelId)
      .order('created_at', { ascending: true })

    if (error) {
      console.error('[GET /api/sembang/channels/[id]/tasks] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load tasks' }, { status: 500 })
    }

    const rows = (data ?? []) as SembangTaskRow[]
    // Already ascending by created_at from the query — filtering
    // preserves that order for the 'open' half. 'done' is re-sorted
    // separately, most recently completed first.
    const open = rows.filter((r) => r.status === 'open')
    const done = rows
      .filter((r) => r.status === 'done')
      .sort((a, b) => {
        const at = a.completed_at ? new Date(a.completed_at).getTime() : 0
        const bt = b.completed_at ? new Date(b.completed_at).getTime() : 0
        return bt - at
      })

    const tasks = await hydrateTasks(ctx.supabase, [...open, ...done])
    return NextResponse.json({ tasks })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId } = await params

    const body = (await request.json().catch(() => null)) as {
      title?: unknown
      assigneeId?: unknown
      dueAt?: unknown
      messageId?: unknown
    } | null

    const title = typeof body?.title === 'string' ? body.title.trim() : ''
    if (!title || title.length > TITLE_MAX) {
      return NextResponse.json(
        { error: `Title must be between 1 and ${TITLE_MAX} characters` },
        { status: 400 },
      )
    }

    const assigneeId = typeof body?.assigneeId === 'string' ? body.assigneeId : null
    const messageId = typeof body?.messageId === 'string' ? body.messageId : null

    let dueAt: string | null = null
    if (body?.dueAt !== undefined && body.dueAt !== null) {
      if (typeof body.dueAt !== 'string') {
        return NextResponse.json({ error: 'dueAt must be an ISO timestamp string' }, { status: 400 })
      }
      const dueDate = new Date(body.dueAt)
      if (Number.isNaN(dueDate.getTime())) {
        return NextResponse.json({ error: 'dueAt must be a valid ISO timestamp' }, { status: 400 })
      }
      dueAt = dueDate.toISOString()
    }

    const { data: row, error } = await ctx.supabase
      .from('sembang_tasks')
      .insert({
        channel_id: channelId,
        account_id: ctx.accountId,
        message_id: messageId,
        title,
        assignee_id: assigneeId,
        due_at: dueAt,
        created_by: ctx.userId,
      })
      .select('*')
      .single()

    if (error) {
      if (error.code === '42501') {
        return NextResponse.json(
          { error: 'You must be a member of this channel to add tasks' },
          { status: 403 },
        )
      }
      console.error('[POST /api/sembang/channels/[id]/tasks] insert error:', error)
      return NextResponse.json({ error: 'Failed to create task' }, { status: 500 })
    }

    const [task] = await hydrateTasks(ctx.supabase, [row as SembangTaskRow])
    return NextResponse.json({ task }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
