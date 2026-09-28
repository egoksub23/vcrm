// ============================================================
// /api/sembang/channels/[id]/tasks/[taskId]/comments
//
//   POST — body `{ body: string }` (sanitized HTML from the rich-text
//          composer). `author_id = ctx.userId`, `mentions` always `[]`
//          in this pass (no @mention picker wired up yet — see
//          sembang_task_comments' migration comment). Notifies every
//          current assignee except the author via a DB trigger. No
//          standalone GET here — TaskDetailDialog refetches the whole
//          task detail after posting.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import type { SembangTaskComment } from '@/types'

const BODY_MAX = 20_000

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { taskId } = await params

    const body = (await request.json().catch(() => null)) as { body?: unknown } | null
    const text = typeof body?.body === 'string' ? body.body.trim() : ''
    if (!text || text.length > BODY_MAX) {
      return NextResponse.json(
        { error: `Comment must be between 1 and ${BODY_MAX} characters` },
        { status: 400 },
      )
    }

    const { data, error } = await ctx.supabase
      .from('sembang_task_comments')
      .insert({
        task_id: taskId,
        account_id: ctx.accountId,
        author_id: ctx.userId,
        body: text,
      })
      .select('*')
      .single()

    if (error) {
      if (error.code === '42501') {
        return NextResponse.json(
          { error: 'You do not have permission to comment on this task' },
          { status: 403 },
        )
      }
      console.error('[POST .../tasks/[taskId]/comments] insert error:', error)
      return NextResponse.json({ error: 'Failed to add comment' }, { status: 500 })
    }

    const { data: profile } = await ctx.supabase
      .from('profiles')
      .select('full_name, avatar_url')
      .eq('user_id', ctx.userId)
      .maybeSingle()

    const comment: SembangTaskComment = {
      id: data.id,
      taskId: data.task_id,
      authorId: data.author_id,
      authorName: profile?.full_name ?? '',
      authorAvatarUrl: profile?.avatar_url ?? null,
      body: data.body,
      mentions: [],
      createdAt: data.created_at,
      editedAt: data.edited_at,
    }
    return NextResponse.json({ comment }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
