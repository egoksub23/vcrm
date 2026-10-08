import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { commentCapabilities, type CommentRow } from '@/lib/comments/types'

type Params = { params: Promise<{ id: string }> }

/** The thread shows this many of the newest comments of a post; `truncated` says when older ones were left out. */
const MAX_COMMENTS = 500

const POST_COLUMNS = 'id, provider, source, external_post_id, message, permalink_url, media_url, media_type, posted_at'

/**
 * GET /api/comments/posts/[id] — one post with ALL its comments, oldest first (ours too, so the thread reads as a conversation), what can be
 * done to each comment right now, and when the caller last opened the post (before this visit; opening is recorded by POST .../seen).
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { id } = await params

    const { data: post } = await supabase
      .from('comment_posts')
      .select(POST_COLUMNS)
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle()
    if (!post) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const [commentsRes, seenRes] = await Promise.all([
      supabase
        .from('comments')
        .select('*')
        .eq('account_id', accountId)
        .eq('post_id', id)
        .order('provider_created_at', { ascending: false })
        .limit(MAX_COMMENTS + 1),
      // row level security limits this to the caller's own row
      supabase.from('comment_post_reads').select('seen_at').eq('post_id', id).maybeSingle(),
    ])
    if (commentsRes.error) {
      console.error('[comments post GET] error:', commentsRes.error)
      return NextResponse.json({ error: 'Failed to load comments' }, { status: 500 })
    }

    const fetched = (commentsRes.data ?? []) as (CommentRow & Record<string, unknown>)[]
    const truncated = fetched.length > MAX_COMMENTS
    const now = Date.now()
    const comments = fetched
      .slice(0, MAX_COMMENTS)
      .reverse()
      .map((c) => ({ ...c, capabilities: commentCapabilities(c, now) }))

    return NextResponse.json({
      post,
      comments,
      truncated,
      seen_at: (seenRes.data as { seen_at?: string } | null)?.seen_at ?? null,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
