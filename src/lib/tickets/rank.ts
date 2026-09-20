// ============================================================
// Board ordering. Every ticket has a `board_rank` (a double); higher is
// nearer the top of its column and the default is the creation time in
// epoch seconds, so an untouched column reads newest first. A drop between
// two cards takes the midpoint of their ranks, so only the moved card is
// written. Halving runs out of precision after a few dozen drops between
// the same two neighbours; `needsRebalance` says when, and
// `rebalanceRanks` spreads a column's ranks evenly again inside the range
// it already spans (so cards that are not loaded keep their place).
// ============================================================

/** How far past the end of a column a drop at the top / bottom lands. */
export const RANK_STEP = 1

/** Below this gap between two neighbours a midpoint is no longer safe. */
export const MIN_RANK_GAP = 1e-4

/** Rank of a card dropped between `above` (nearer the top, higher rank)
 *  and `below`. Either may be missing at the ends of a column. */
export function rankBetween(
  above: number | null | undefined,
  below: number | null | undefined,
  now: number = Date.now() / 1000,
): number {
  const hasAbove = typeof above === 'number'
  const hasBelow = typeof below === 'number'
  if (hasAbove && hasBelow) return (above + below) / 2
  if (hasBelow) return below + RANK_STEP
  if (hasAbove) return above - RANK_STEP
  return now
}

/** True when the gap between two neighbours is too small to halve again. */
export function needsRebalance(
  above: number | null | undefined,
  below: number | null | undefined,
): boolean {
  if (typeof above !== 'number' || typeof below !== 'number') return false
  return above - below < MIN_RANK_GAP
}

/**
 * Evenly spread a column's ranks (given highest first) across the range they
 * already span. A column whose ranks are all equal is spread by RANK_STEP
 * downwards from that value.
 */
export function rebalanceRanks(ranks: number[]): number[] {
  const n = ranks.length
  if (n === 0) return []
  const max = Math.max(...ranks)
  const min = Math.min(...ranks)
  if (n === 1) return [max]
  const step = max > min ? (max - min) / (n - 1) : RANK_STEP
  return ranks.map((_, i) => max - i * step)
}

/**
 * The rank for a card dropped at `index` in a column whose other cards have
 * `otherRanks` (highest first, without the dragged card).
 */
export function planDrop(
  otherRanks: number[],
  index: number,
  now?: number,
): { rank: number; rebalance: boolean } {
  const i = Math.max(0, Math.min(index, otherRanks.length))
  const above = i > 0 ? otherRanks[i - 1] : null
  const below = i < otherRanks.length ? otherRanks[i] : null
  return { rank: rankBetween(above, below, now), rebalance: needsRebalance(above, below) }
}

/** Highest rank first; ties fall back to newest, then id, so the order is
 *  the same on every client. */
export function compareByRank(
  a: { board_rank?: number; created_at: string; id: string },
  b: { board_rank?: number; created_at: string; id: string },
): number {
  const ra = a.board_rank ?? 0
  const rb = b.board_rank ?? 0
  if (ra !== rb) return rb - ra
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
