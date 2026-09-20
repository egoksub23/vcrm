import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { buildInsights, type InsightDoc, type InsightGap } from '@/lib/knowledge/insights'

const WINDOW_DAYS = 30

/**
 * GET /api/knowledge/insights   (any member)
 *
 * The last 30 days: the articles the AI used most, the published ones it never
 * used, and the articles written to answer a question it used to hand off.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString()

    const [docsRes, usesRes, gapsRes] = await Promise.all([
      supabase
        .from('ai_knowledge_documents')
        .select('id, title, status, use_in_ai, updated_at')
        .eq('account_id', accountId)
        .limit(5000),
      supabase.rpc('kb_usage_counts', { p_account_id: accountId, p_since: since }),
      supabase
        .from('knowledge_gaps')
        .select('resolved_document_id, times_asked, resolved_at, last_asked_at')
        .eq('account_id', accountId)
        .eq('status', 'resolved')
        .not('resolved_document_id', 'is', null)
        .limit(5000),
    ])
    if (docsRes.error) {
      console.error('[knowledge/insights] error:', docsRes.error)
      return NextResponse.json({ error: 'Failed to load insights' }, { status: 500 })
    }

    const uses = new Map<string, number>()
    for (const row of (usesRes.data ?? []) as { document_id: string; uses: number | string }[]) {
      uses.set(row.document_id, Number(row.uses) || 0)
    }
    const sinceMs = Date.parse(since)
    const resolvedGaps: InsightGap[] = ((gapsRes.data ?? []) as {
      resolved_document_id: string | null
      times_asked: number
      resolved_at: string | null
      last_asked_at: string
    }[]).filter((g) => Date.parse(g.resolved_at ?? g.last_asked_at) >= sinceMs)

    return NextResponse.json(
      buildInsights({
        windowDays: WINDOW_DAYS,
        docs: (docsRes.data ?? []) as InsightDoc[],
        uses,
        resolvedGaps,
      }),
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}
