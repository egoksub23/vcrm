import type { KnowledgeInsights } from '@/lib/knowledge-types'

// ============================================================
// The Insights view: which articles the AI leans on, which it never touches,
// and which ones fixed a question it used to hand off. Pure aggregation; the
// route does the reading.
// ============================================================

export interface InsightDoc {
  id: string
  title: string
  status: 'draft' | 'published'
  use_in_ai: boolean
  updated_at: string
}
export interface InsightGap {
  resolved_document_id: string | null
  times_asked: number
}

const LIMIT = 10
const NEVER_USED_LIMIT = 20

export function buildInsights(args: {
  windowDays: number
  docs: InsightDoc[]
  /** document id -> AI uses inside the window */
  uses: Map<string, number>
  /** questions resolved inside the window */
  resolvedGaps: InsightGap[]
}): KnowledgeInsights {
  const { docs, uses, resolvedGaps, windowDays } = args
  const byId = new Map(docs.map((d) => [d.id, d]))

  const most_used = Array.from(uses, ([id, n]) => ({ id, uses: n }))
    .filter((u) => u.uses > 0 && byId.has(u.id))
    .sort((a, b) => b.uses - a.uses || byId.get(a.id)!.title.localeCompare(byId.get(b.id)!.title))
    .slice(0, LIMIT)
    .map((u) => ({ id: u.id, title: byId.get(u.id)!.title, uses: u.uses }))

  // Only articles the AI could actually use count as "never used".
  const never_used = docs
    .filter((d) => d.status === 'published' && d.use_in_ai && !(uses.get(d.id) ?? 0))
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
    .slice(0, NEVER_USED_LIMIT)
    .map((d) => ({ id: d.id, title: d.title, updated_at: d.updated_at }))

  // Each resolved question counts as the number of times it was asked: that
  // is how many handoffs the article now prevents.
  const closed = new Map<string, number>()
  for (const g of resolvedGaps) {
    if (!g.resolved_document_id || !byId.has(g.resolved_document_id)) continue
    closed.set(g.resolved_document_id, (closed.get(g.resolved_document_id) ?? 0) + Math.max(g.times_asked, 1))
  }
  const handoff_fixes = Array.from(closed, ([id, handoffs]) => ({ id, title: byId.get(id)!.title, handoffs }))
    .sort((a, b) => b.handoffs - a.handoffs || a.title.localeCompare(b.title))
    .slice(0, LIMIT)

  return { window_days: windowDays, most_used, never_used, handoff_fixes }
}
