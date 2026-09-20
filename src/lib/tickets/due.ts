// ============================================================
// Due dates are plain dates (no time of day). A ticket is due at the END of
// that day in the viewer's time zone: overdue once the day is over, "soon"
// while less than 24 hours remain (that is, on the due day itself).
// ============================================================

export type DueState =
  /** No due date. */
  | 'none'
  /** Has a due date, but the ticket is resolved / closed. */
  | 'done'
  | 'overdue'
  | 'soon'
  | 'later'

const DAY_MS = 24 * 60 * 60 * 1000

/** The end of a yyyy-mm-dd day in local time, or null when malformed. */
export function endOfDueDay(dueDate: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dueDate)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2]) - 1
  const d = Number(m[3])
  const end = new Date(y, mo, d, 23, 59, 59, 999)
  return Number.isNaN(end.getTime()) || end.getMonth() !== mo ? null : end
}

export function dueState(
  dueDate: string | null | undefined,
  now: Date = new Date(),
  done = false,
): DueState {
  if (!dueDate) return 'none'
  const end = endOfDueDay(dueDate)
  if (!end) return 'none'
  if (done) return 'done'
  const remaining = end.getTime() - now.getTime()
  if (remaining < 0) return 'overdue'
  if (remaining <= DAY_MS) return 'soon'
  return 'later'
}

/** yyyy-mm-dd for a local date, as the DATE column stores it. */
export function toDateInputValue(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}
