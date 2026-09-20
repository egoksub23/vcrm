import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { daysAgoStart, lastNDayKeys, localDayKey } from '@/lib/dashboard/date-utils'

// Rows are aggregated in-process over a bounded window. An active
// account writes a handful of rows per conversation, so 30 days sits
// comfortably under this cap; we surface `truncated` when it doesn't so
// the UI can say "showing a partial window" rather than under-reporting
// silently.
const MAX_ROWS = 10_000
const DEFAULT_WINDOW_DAYS = 30

type UsageMode = 'auto_reply' | 'draft' | 'auto_label' | 'closing_note' | 'summary' | 'translate'

interface UsageRow {
  created_at: string
  mode: UsageMode
  connection_id: string | null
  provider: string
  model: string
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

/**
 * GET /api/ai/usage?days=30  (admin+)
 *
 * Token-spend summary for the account's BYO key over the last `days`
 * (1–90, default 30): totals, per-mode + per-model breakdowns, and a
 * zero-filled daily series for charting. Admin-only, mirroring the
 * `ai_usage_log` SELECT policy — spend is billing-class.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')

    const url = new URL(request.url)
    const rawDays = Number(url.searchParams.get('days'))
    // Guard `>= 1`, not just `isFinite`: a missing/blank param is
    // Number(null)/Number('') === 0, which is finite — without the lower
    // bound the default would never apply and the window would collapse
    // to a single day.
    const days =
      Number.isFinite(rawDays) && rawDays >= 1
        ? Math.min(90, Math.floor(rawDays))
        : DEFAULT_WINDOW_DAYS

    // Align the query cutoff to the START of the oldest local day we'll
    // chart (not a rolling `now - N*24h` instant). Otherwise rows in the
    // oldest partial day would be counted in the totals but fall outside
    // every daily bucket, so the chart's bars wouldn't sum to the
    // headline total. Local-day boundaries match every other dashboard
    // chart (see lib/dashboard/date-utils).
    const since = daysAgoStart(days - 1)

    const { data, error } = await supabase
      .from('ai_usage_log')
      .select(
        'created_at, mode, connection_id, provider, model, prompt_tokens, completion_tokens, total_tokens',
      )
      .eq('account_id', accountId)
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: false })
      .limit(MAX_ROWS + 1)

    if (error) {
      console.error('[ai/usage GET] fetch error:', error)
      return NextResponse.json(
        { error: 'Failed to load usage' },
        { status: 500 },
      )
    }

    const all = (data ?? []) as UsageRow[]
    const truncated = all.length > MAX_ROWS
    const rows = truncated ? all.slice(0, MAX_ROWS) : all

    // Totals.
    let promptTokens = 0
    let completionTokens = 0
    let totalTokens = 0

    // Per-mode + per-model tallies.
    const byMode: Record<UsageMode, { calls: number; tokens: number }> = {
      auto_reply: { calls: 0, tokens: 0 },
      draft: { calls: 0, tokens: 0 },
      auto_label: { calls: 0, tokens: 0 },
      closing_note: { calls: 0, tokens: 0 },
      summary: { calls: 0, tokens: 0 },
      translate: { calls: 0, tokens: 0 },
    }
    // Per connection: null id = the default connection.
    const connMap = new Map<string, { id: string | null; calls: number; tokens: number }>()
    const modelMap = new Map<
      string,
      { model: string; provider: string; calls: number; tokens: number }
    >()

    // Zero-filled daily buckets so the chart shows quiet days as gaps,
    // not missing points. Local-day keys, oldest → newest — the same
    // helper every other dashboard chart uses, so day boundaries agree.
    const daily = new Map<string, { date: string; tokens: number; calls: number }>()
    for (const key of lastNDayKeys(days)) {
      daily.set(key, { date: key, tokens: 0, calls: 0 })
    }

    for (const r of rows) {
      promptTokens += r.prompt_tokens
      completionTokens += r.completion_tokens
      totalTokens += r.total_tokens

      // `mode` is DB-CHECK-constrained to the values above.
      if (byMode[r.mode]) {
        byMode[r.mode].calls += 1
        byMode[r.mode].tokens += r.total_tokens
      }
      const ck = r.connection_id ?? 'default'
      const c = connMap.get(ck) ?? { id: r.connection_id, calls: 0, tokens: 0 }
      c.calls += 1
      c.tokens += r.total_tokens
      connMap.set(ck, c)

      const mk = `${r.provider}:${r.model}`
      const m =
        modelMap.get(mk) ??
        { model: r.model, provider: r.provider, calls: 0, tokens: 0 }
      m.calls += 1
      m.tokens += r.total_tokens
      modelMap.set(mk, m)

      const bucket = daily.get(localDayKey(r.created_at))
      if (bucket) {
        bucket.tokens += r.total_tokens
        bucket.calls += 1
      }
    }

    const byModel = [...modelMap.values()].sort((a, b) => b.tokens - a.tokens)

    // Name the connections (a deleted one shows as unknown).
    const ids = [...connMap.values()].map((c) => c.id).filter((x): x is string => !!x)
    const names = new Map<string, string>()
    if (ids.length > 0) {
      const { data: conns } = await supabase.from('ai_connections').select('id, name').in('id', ids)
      for (const c of conns ?? []) names.set(c.id as string, c.name as string)
    }
    const byConnection = [...connMap.values()]
      .map((c) => ({ id: c.id, name: c.id ? (names.get(c.id) ?? null) : null, calls: c.calls, tokens: c.tokens }))
      .sort((a, b) => b.tokens - a.tokens)

    return NextResponse.json({
      window_days: days,
      truncated,
      totals: {
        calls: rows.length,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      },
      by_mode: byMode,
      by_model: byModel,
      by_connection: byConnection,
      daily: [...daily.values()],
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
