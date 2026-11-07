// The database driver hands timestamps and dates back as Date objects; the incident code (and the JSON it sends) works with text. These turn either into text, so a
// string comparison or slice on a value read from the database cannot fail (a Date has no slice, and a Date never compares greater than a "2026-11-20").

/** A timestamp as ISO text (a Date, or text already). Null stays null. */
export function isoOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return String(value);
}

/** A calendar day as "YYYY-MM-DD" (from a Date, or timestamp text, or day text). Null stays null. */
export function dayOf(value: unknown): string | null {
  const iso = isoOf(value);
  return iso === null ? null : iso.slice(0, 10);
}

/** The row with the named columns turned into ISO text (`timestamps`) and day text (`days`). */
export function textDates<T extends object>(row: T, timestamps: readonly string[], days: readonly string[] = []): T {
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const k of timestamps) if (k in out) out[k] = isoOf(out[k]);
  for (const k of days) if (k in out) out[k] = dayOf(out[k]);
  return out as T;
}
