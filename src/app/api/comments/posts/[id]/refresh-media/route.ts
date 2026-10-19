import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { refreshPostMedia } from '@/lib/comments/refresh-post-media'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'

type Params = { params: Promise<{ id: string }> }

export const maxDuration = 30

/**
 * POST /api/comments/posts/[id]/refresh-media  (any member of the workspace)
 *
 * A post's thumbnail failed to load because the link Meta gave us has expired. Ask Meta for a fresh one with the workspace's own page token, keep a
 * copy in our storage, point the post at it, and answer with the new link. Anyone who can see the post can need this (it only ever rewrites the
 * picture of a post in their own workspace), so it asks for no capability beyond being a member. Rate limited per person: a screen full of dead
 * thumbnails is one call each.
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { accountId, userId } = await getCurrentAccount()
    const limit = checkRateLimit(`comment-media:${userId}`, { limit: 60, windowMs: 60_000 })
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const result = await refreshPostMedia(supabaseAdmin(), accountId, id)
    if (!result.ok) {
      return NextResponse.json({ error: 'The picture is not available.', reason: result.reason }, { status: result.reason === 'not_found' ? 404 : 409 })
    }
    return NextResponse.json({ media_url: result.mediaUrl, changed: result.changed })
  } catch (err) {
    return toErrorResponse(err)
  }
}
