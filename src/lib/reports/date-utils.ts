import { localDayKey, startOfLocalDay } from '@/lib/dashboard/date-utils'

export interface DateRange {
  /** Inclusive, local start-of-day. */
  from: Date
  /** Inclusive, local start-of-day — the report covers through the END
   *  of this day, callers query with an exclusive upper bound one day
   *  past this. */
  to: Date
}

/** The immediately-preceding period of equal length, for the
 *  "vs. previous period" comparison every report tile shows. A 7-day
 *  range ending today compares against the 7 days before that. */
export function previousPeriod({ from, to }: DateRange): DateRange {
  const days = daysBetweenInclusive(from, to)
  const prevTo = new Date(from)
  prevTo.setDate(prevTo.getDate() - 1)
  const prevFrom = new Date(prevTo)
  prevFrom.setDate(prevFrom.getDate() - (days - 1))
  return { from: startOfLocalDay(prevFrom), to: startOfLocalDay(prevTo) }
}

export function daysBetweenInclusive(from: Date, to: Date): number {
  const ms = startOfLocalDay(to).getTime() - startOfLocalDay(from).getTime()
  return Math.round(ms / 86_400_000) + 1
}

/** Exclusive upper bound for a Postgres `.lt(...)` query — the start
 *  of the day AFTER `to`, so the range covers all of `to` itself. */
export function exclusiveEnd(to: Date): Date {
  const out = startOfLocalDay(to)
  out.setDate(out.getDate() + 1)
  return out
}

/** Inclusive list of local-day keys spanning `range`, chronological —
 *  seeds chart buckets so days with zero activity still render. */
export function dayKeysInRange(range: DateRange): string[] {
  const keys: string[] = []
  const cursor = startOfLocalDay(range.from)
  const end = startOfLocalDay(range.to)
  while (cursor.getTime() <= end.getTime()) {
    keys.push(localDayKey(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return keys
}

/** % change from `previous` to `current`, or null when `previous` is 0
 *  (a percentage against zero is meaningless, not "+Infinity%"). */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null
  return ((current - previous) / previous) * 100
}

export { localDayKey }
