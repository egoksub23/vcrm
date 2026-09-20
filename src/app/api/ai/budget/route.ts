import { NextResponse } from 'next/server'
import { requireCapability, toErrorResponse } from '@/lib/auth/account'

const MAX_BUDGET = 1_000_000_000_000

/**
 * PUT /api/ai/budget  (admin+)
 * Body: { monthly_token_budget: number | null }   (null = no limit)
 *
 * The monthly token budget for all AI jobs on this account. Changing it
 * re-arms the 80% alert for the current month.
 */
export async function PUT(request: Request) {
  try {
    const { supabase, accountId } = await requireCapability('ai.configure')
    const body = (await request.json().catch(() => null)) as { monthly_token_budget?: unknown } | null
    if (!body || !('monthly_token_budget' in body)) {
      return NextResponse.json({ error: 'monthly_token_budget is required' }, { status: 400 })
    }
    const raw = body.monthly_token_budget
    let budget: number | null = null
    if (raw !== null && raw !== '') {
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 1 || n > MAX_BUDGET) {
        return NextResponse.json({ error: 'Enter a whole number of tokens, or leave it empty for no limit.' }, { status: 400 })
      }
      budget = Math.floor(n)
    }

    const { data, error } = await supabase
      .from('ai_configs')
      .update({ monthly_token_budget: budget, budget_alert_month: null })
      .eq('account_id', accountId)
      .select('account_id')
      .maybeSingle()
    if (error) {
      console.error('[ai/budget PUT] error:', error)
      return NextResponse.json({ error: 'Failed to save the budget' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Set up an AI connection first.' }, { status: 409 })
    return NextResponse.json({ success: true, monthly_token_budget: budget })
  } catch (err) {
    return toErrorResponse(err)
  }
}
