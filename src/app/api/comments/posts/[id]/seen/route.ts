import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

type Params = { params: Promise<{ id: string }> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * POST /api/comments/posts/[id]/seen — the caller has opened this post: clears its unread dot for them (and only them).
 * Any member; it records the person's own reading, not a change to the post. Runs as the caller (comment_post_mark_seen, migration 180).
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { supabase } = await getCurrentAccount()
    const { id } = await params
    if (!UUID.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const { data, error } = await supabase.rpc('comment_post_mark_seen', { p_post: id })
    if (error) {
      console.error('[comments seen POST] error:', error)
      return NextResponse.json({ error: 'Could not record that' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ seen_at: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
