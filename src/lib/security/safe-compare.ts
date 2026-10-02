import { timingSafeEqual } from 'node:crypto'

/**
 * Compare two secrets/tokens in constant time. Different lengths are
 * unequal immediately (the length itself is not sensitive); a missing
 * value never matches.
 */
export function tokensEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  if (x.length !== y.length) return false
  return timingSafeEqual(x, y)
}

/**
 * Escape LIKE wildcards (`\`, `%`, `_`) so a value is matched literally by
 * ilike. Use for case-insensitive equality on a column without a lower()
 * index expression PostgREST can call, e.g. an email address.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => '\\' + c)
}
