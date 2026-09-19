import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { COMMENT_PROVIDERS } from '@/lib/comments/types'

const PAGE_SIZE = 40

/**
 * GET /api/comments?view=open|done|spam|all&provider=&q=&before=<iso>
 *
 * The Comments inbox list (any member): customers' comments, newest
 * first, with the post each sits under. Our own replies are not rows here;
 * they appear inside a comment's thread.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const sp = new URL(request.url).searchParams
    const view = sp.get('view') ?? 'open'
    const provider = sp.get('provider')
    const q = (sp.get('q') ?? '').trim().slice(0, 100)
    const before = sp.get('before')

    let query = supabase
      .from('comments')
      .select(
        '*, post:comment_posts(id, provider, source, message, permalink_url, media_url, media_type, posted_at)',
      )
      .eq('account_id', accountId)
      .eq('direction', 'inbound')
      .order('provider_created_at', { ascending: false })
      .limit(PAGE_SIZE + 1)

    if (view === 'open') query = query.eq('handled_status', 'open').neq('status', 'deleted')
    else if (view === 'done') query = query.in('handled_status', ['replied', 'resolved'])
    else if (view === 'spam') query = query.eq('handled_status', 'spam')
    else if (view !== 'all') return NextResponse.json({ error: 'Unknown view' }, { status: 400 })

    if (provider) {
      if (!(COMMENT_PROVIDERS as readonly string[]).includes(provider)) {
        return NextResponse.json({ error: 'Unknown provider' }, { status: 400 })
      }
      query = query.eq('provider', provider)
    }
    if (q) {
      // Escape the characters PostgREST's or() filter treats as syntax.
      const safe = q.replace(/[%,()*\\]/g, ' ')
      query = query.or(`text.ilike.%${safe}%,author_name.ilike.%${safe}%,author_username.ilike.%${safe}%`)
    }
    if (before) query = query.lt('provider_created_at', before)

    const { data, error } = await query
    if (error) {
      console.error('[comments GET] error:', error)
      return NextResponse.json({ error: 'Failed to load comments' }, { status: 500 })
    }
    const rows = data ?? []
    return NextResponse.json({
      comments: rows.slice(0, PAGE_SIZE),
      has_more: rows.length > PAGE_SIZE,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
