import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

/**
 * GET /api/knowledge/gaps?status=open|resolved|dismissed   (any member)
 *
 * Questions the AI handed off for lack of an article, most-asked first.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const status = new URL(request.url).searchParams.get('status') ?? 'open'
    if (!['open', 'resolved', 'dismissed'].includes(status)) {
      return NextResponse.json({ error: 'Unknown status' }, { status: 400 })
    }
    const { data, error } = await supabase
      .from('knowledge_gaps')
      .select('id, question, times_asked, conversation_id, status, resolved_document_id, last_asked_at')
      .eq('account_id', accountId)
      .eq('status', status)
      .order('times_asked', { ascending: false })
      .order('last_asked_at', { ascending: false })
      .limit(200)
    if (error) {
      console.error('[knowledge/gaps GET] error:', error)
      return NextResponse.json({ error: 'Failed to load unanswered questions' }, { status: 500 })
    }

    // Counts for the tab labels.
    const counts: Record<string, number> = { open: 0, resolved: 0, dismissed: 0 }
    await Promise.all(
      Object.keys(counts).map(async (s) => {
        const { count } = await supabase
          .from('knowledge_gaps')
          .select('id', { count: 'exact', head: true })
          .eq('account_id', accountId)
          .eq('status', s)
        counts[s] = count ?? 0
      }),
    )
    return NextResponse.json({ gaps: data ?? [], counts })
  } catch (err) {
    return toErrorResponse(err)
  }
}
