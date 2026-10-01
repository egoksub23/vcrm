// ============================================================
// /api/sembang/channels/[id]/tasks/[taskId]/comments
//
//   POST — body `{ body: string, mentions?: string[] }` (sanitized HTML
//          from the rich-text composer, plus the ids the mention picker
//          tagged). `author_id = ctx.userId`. `mentions` is re-validated
//          server-side against the channel's real membership (service
//          role, so it can't be spoofed) before storing — anyone not
//          currently a member of this channel is silently dropped, the
//          same defense-in-depth posture as the ticket comment mention
//          flow. Notifies every current assignee except the author
//          (existing trigger) and every validated mention (migration
//          126). No standalone GET here — TaskDetailDialog refetches the
//          whole task detail after posting.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import type { SembangTaskComment } from '@/types'

const BODY_MAX = 20_000

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId, taskId } = await params

    const body = (await request.json().catch(() => null)) as
      | { body?: unknown; mentions?: unknown }
      | null
    const text = typeof body?.body === 'string' ? body.body.trim() : ''
    if (!text || text.length > BODY_MAX) {
      return NextResponse.json(
        { error: `Comment must be between 1 and ${BODY_MAX} characters` },
        { status: 400 },
      )
    }
    const requestedMentions = Array.isArray(body?.mentions)
      ? [...new Set(body.mentions.filter((id): id is string => typeof id === 'string'))]
      : []

    let mentions: string[] = []
    if (requestedMentions.length > 0) {
      const { data: members } = await supabaseAdmin()
        .from('sembang_channel_members')
        .select('user_id')
        .eq('channel_id', channelId)
        .in('user_id', requestedMentions)
      mentions = (members ?? []).map((m) => m.user_id)
    }

    const { data, error } = await ctx.supabase
      .from('sembang_task_comments')
      .insert({
        task_id: taskId,
        account_id: ctx.accountId,
        author_id: ctx.userId,
        body: text,
        mentions,
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
      mentions: data.mentions ?? [],
      createdAt: data.created_at,
      editedAt: data.edited_at,
    }
    return NextResponse.json({ comment }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
