// Keeping and deleting incident records. The school decides how long: by default records stay until the school deletes them; it may set a number of
// years after which closed incidents are removed. Deleting is always preceded by an export the person can download, and is logged.

export const RETENTION_MIN_YEARS = 1;
export const RETENTION_MAX_YEARS = 50;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** `null` means "keep until we delete them". */
export function parseRetentionYears(value: unknown): Parsed<number | null> {
  if (value === null || value === "" || value === undefined) return { ok: true, value: null };
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < RETENTION_MIN_YEARS || n > RETENTION_MAX_YEARS) {
    return { ok: false, error: `Choose a whole number of years between ${RETENTION_MIN_YEARS} and ${RETENTION_MAX_YEARS}, or keep everything until you delete it.` };
  }
  return { ok: true, value: n };
}

/** The date before which closed incidents are removed under a retention period. */
export function cutoffForYears(years: number, now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()));
  return d.toISOString().slice(0, 10);
}

/** A cutoff someone typed for a manual delete: a real date, in the past, at least a day ago (today's records are never "old"). */
export function parseCutoff(value: unknown, now: Date): Parsed<string> {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) return { ok: false, error: "Choose a date, like 2024-12-31." };
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)).toISOString().slice(0, 10);
  if (value > yesterday) return { ok: false, error: "Choose a date before today." };
  return { ok: true, value };
}

/** What the person must type to confirm a delete. */
export function purgePhrase(count: number): string {
  return `DELETE ${count}`;
}

export interface ExportBundle {
  exported_at: string;
  cutoff: string;
  note: string;
  incidents: Record<string, unknown>[];
}

/** The export file: plain JSON an auditor or the school can open. Includes people named and steps; attachments are listed by name, with their address. */
export function buildExport(args: { now: Date; cutoff: string; incidents: Record<string, unknown>[] }): ExportBundle {
  return {
    exported_at: args.now.toISOString(),
    cutoff: args.cutoff,
    note: "Incident records closed on or before the cutoff. Keep this file safe: it can contain children's names and medical details.",
    incidents: args.incidents,
  };
}
