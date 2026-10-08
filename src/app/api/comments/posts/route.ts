import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { COMMENT_PROVIDERS } from '@/lib/comments/types'
import { POST_VIEWS } from '@/lib/comments/threads'

const PAGE_SIZE = 40

/**
 * GET /api/comments/posts?view=open|done|spam|all&provider=&q=&offset=<n>
 *
 * The Comments inbox list, one row per POST (any member). The rules (what To do / Handled / Spam / All mean, how unread works, what a search
 * matches) live in comment_posts_inbox(), migration 180, which runs as the caller so row level security decides what is visible.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const sp = new URL(request.url).searchParams
    const view = sp.get('view') ?? 'open'
    const provider = sp.get('provider') || null
    const q = (sp.get('q') ?? '').trim().slice(0, 100)
    const offset = Math.max(0, Math.min(Number.parseInt(sp.get('offset') ?? '0', 10) || 0, 100_000))

    if (!(POST_VIEWS as readonly string[]).includes(view)) return NextResponse.json({ error: 'Unknown view' }, { status: 400 })
    if (provider && !(COMMENT_PROVIDERS as readonly string[]).includes(provider)) {
      return NextResponse.json({ error: 'Unknown provider' }, { status: 400 })
    }

    const { data, error } = await supabase.rpc('comment_posts_inbox', {
      p_account: accountId,
      p_provider: provider,
      p_filter: view,
      p_search: q || null,
      p_limit: PAGE_SIZE + 1,
      p_offset: offset,
    })
    if (error) {
      console.error('[comments posts GET] error:', error)
      return NextResponse.json({ error: 'Failed to load comments' }, { status: 500 })
    }
    const rows = (data ?? []) as unknown[]
    return NextResponse.json({
      posts: rows.slice(0, PAGE_SIZE),
      has_more: rows.length > PAGE_SIZE,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
