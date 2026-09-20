import { NextResponse } from 'next/server'
import { getCurrentAccount, requireCapability, toErrorResponse } from '@/lib/auth/account'
import { commentCapabilities } from '@/lib/comments/types'

type Params = { params: Promise<{ id: string }> }

/**
 * GET /api/comments/[id] — one comment with the whole thread around it,
 * the post, what agents have done to it, and what is allowed now.
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { id } = await params

    const { data: comment } = await supabase
      .from('comments')
      .select('*, post:comment_posts(*)')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle()
    if (!comment) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // The thread hangs off the top-level comment.
    const rootId = (comment.parent_comment_id as string | null) ?? (comment.id as string)
    const [rootRes, repliesRes, actionsRes, contactRes] = await Promise.all([
      supabase.from('comments').select('*').eq('account_id', accountId).eq('id', rootId).maybeSingle(),
      supabase
        .from('comments')
        .select('*')
        .eq('account_id', accountId)
        .eq('parent_comment_id', rootId)
        .order('provider_created_at', { ascending: true })
        .limit(200),
      supabase
        .from('comment_actions')
        .select('id, action, text, status, error_message, actor_user_id, created_at')
        .eq('account_id', accountId)
        .eq('comment_id', id)
        .order('created_at', { ascending: false })
        .limit(20),
      comment.contact_id
        ? supabase.from('contacts').select('id, name, phone').eq('id', comment.contact_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ])

    const thread = [rootRes.data, ...(repliesRes.data ?? [])].filter(Boolean)
    return NextResponse.json({
      comment,
      thread,
      actions: actionsRes.data ?? [],
      contact: contactRes.data ?? null,
      capabilities: commentCapabilities(comment),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** PATCH /api/comments/[id] — { handled_status?, assigned_to? } (agent+) */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireCapability('comments.moderate')
    const { id } = await params
    const body = (await request.json().catch(() => null)) as {
      handled_status?: unknown
      assigned_to?: unknown
    } | null

    const update: Record<string, unknown> = {}
    if (body?.handled_status !== undefined) {
      if (!['open', 'replied', 'resolved', 'spam'].includes(body.handled_status as string)) {
        return NextResponse.json({ error: 'Unknown status' }, { status: 400 })
      }
      update.handled_status = body.handled_status
    }
    if (body?.assigned_to !== undefined) {
      if (body.assigned_to !== null && typeof body.assigned_to !== 'string') {
        return NextResponse.json({ error: 'assigned_to must be a user id or null' }, { status: 400 })
      }
      update.assigned_to = body.assigned_to
    }
    if (Object.keys(update).length === 0) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })

    const { data, error } = await supabase
      .from('comments')
      .update(update)
      .eq('account_id', accountId)
      .eq('id', id)
      .select('*')
      .maybeSingle()
    if (error) {
      console.error('[comments PATCH] error:', error)
      return NextResponse.json({ error: 'Failed to update the comment' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ comment: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
