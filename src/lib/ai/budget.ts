import type { SupabaseClient } from '@supabase/supabase-js'
import { AiError, type AiConfig } from './types'

// ============================================================
// Monthly token budget. Usage is summed from ai_usage_log for the current
// calendar month (UTC). At 80% the admins get one notification; at 100%
// AI calls stop with a typed `budget_exceeded` error, so the UI can fall
// back to writing by hand instead of failing mysteriously.
//
// Always best-effort on the reading side: if the usage lookup itself
// fails, the call goes ahead. A budget guard must never be the thing that
// takes replies down.
// ============================================================

export const BUDGET_WARN_FRACTION = 0.8

export interface BudgetState {
  budget: number | null
  used: number
  /** 0..1+ ; null with no budget. */
  fraction: number | null
  warn: boolean
  exceeded: boolean
}

export function budgetState(used: number, budget: number | null | undefined): BudgetState {
  if (!budget || budget <= 0) return { budget: null, used, fraction: null, warn: false, exceeded: false }
  const fraction = used / budget
  return { budget, used, fraction, warn: fraction >= BUDGET_WARN_FRACTION, exceeded: used >= budget }
}

export const monthKey = (d: Date = new Date()) => d.toISOString().slice(0, 7)

export async function tokensThisMonth(db: SupabaseClient, accountId: string): Promise<number | null> {
  try {
    const { data, error } = await db.rpc('ai_tokens_this_month', { p_account_id: accountId })
    if (error) {
      console.error('[ai budget] usage lookup failed:', error)
      return null
    }
    return Number(data ?? 0)
  } catch (err) {
    console.error('[ai budget] usage lookup failed:', err)
    return null
  }
}

/**
 * Throws `budget_exceeded` when the month's budget is used up; sends the
 * 80% alert once per month. No-op without a budget.
 */
export async function ensureWithinBudget(
  db: SupabaseClient,
  accountId: string,
  config: Pick<AiConfig, 'monthlyTokenBudget'>,
): Promise<void> {
  const budget = config.monthlyTokenBudget
  if (!budget || budget <= 0) return

  const used = await tokensThisMonth(db, accountId)
  if (used === null) return
  const state = budgetState(used, budget)

  if (state.warn) void sendBudgetAlert(db, accountId, state)
  if (state.exceeded) {
    throw new AiError('The monthly AI token budget has been used up.', {
      code: 'budget_exceeded',
      status: 429,
    })
  }
}

/** One notification per admin per month, claimed atomically so two
 *  concurrent calls cannot both send it. Never throws. */
export async function sendBudgetAlert(db: SupabaseClient, accountId: string, state: BudgetState): Promise<void> {
  try {
    const month = monthKey()
    const { data: claimed } = await db
      .from('ai_configs')
      .update({ budget_alert_month: month })
      .eq('account_id', accountId)
      .or(`budget_alert_month.is.null,budget_alert_month.neq.${month}`)
      .select('account_id')
    if (!claimed || claimed.length === 0) return

    const { data: admins } = await db
      .from('profiles')
      .select('user_id')
      .eq('account_id', accountId)
      .in('account_role', ['owner', 'admin'])
    if (!admins || admins.length === 0) return

    const pct = Math.min(999, Math.round((state.fraction ?? 0) * 100))
    const title = state.exceeded ? 'AI budget used up' : `AI budget at ${pct}%`
    const body = `${state.used.toLocaleString('en-US')} of ${(state.budget ?? 0).toLocaleString('en-US')} tokens used this month.${
      state.exceeded ? ' AI replies are paused until next month or the budget is raised.' : ''
    }`
    const { error } = await db.from('notifications').insert(
      admins.map((a) => ({
        account_id: accountId,
        user_id: a.user_id as string,
        type: 'ai_budget',
        title,
        body,
      })),
    )
    if (error) console.error('[ai budget] alert insert failed:', error)
  } catch (err) {
    console.error('[ai budget] alert failed:', err)
  }
}
