// Registers (injuries, data breaches, near misses ...), trends and the CSV export. Pure: rows in, rows or a file out.

import { severityRank } from "@/lib/incidents/constants";
import { isNearMissCategory } from "./overview";

export interface RegisterIncident {
  id: string;
  incident_number: number;
  created_at: string;
  closed_at: string | null;
  title: string;
  incident_type: string;
  severity: string;
  status: string;
  incident_flags: string[] | null;
  source?: string | null;
  is_test?: boolean | null;
  activity?: { name?: string; venue?: string; date?: string | null; time?: string | null } | null;
  involved_count?: number;
  occurred_at?: string | null;
}

export const REGISTERS = ["all", "injury", "breach", "near_miss", "property", "safeguarding"] as const;
export type RegisterKey = (typeof REGISTERS)[number];

export function isRegister(v: unknown): v is RegisterKey {
  return typeof v === "string" && (REGISTERS as readonly string[]).includes(v);
}

const hasFlag = (i: RegisterIncident, ...flags: string[]) => (i.incident_flags ?? []).some((f) => flags.includes(f));

/** Does the incident belong in this register? A register is a view; an incident can be in several. */
export function inRegister(i: RegisterIncident, register: RegisterKey, categories: readonly { code: string; name: string }[]): boolean {
  switch (register) {
    case "all":
      return true;
    case "injury":
      return hasFlag(i, "injury");
    case "breach":
      return hasFlag(i, "personal_data", "infosec", "security_breach");
    case "near_miss":
      return categories.filter(isNearMissCategory).some((c) => c.code === i.incident_type);
    case "property":
      return hasFlag(i, "property_damage");
    case "safeguarding":
      return hasFlag(i, "safeguarding");
  }
}

export interface Range {
  from: string | null;
  to: string | null;
}

/** Dates are YYYY-MM-DD, inclusive at both ends, compared on the incident's UTC date. */
export function inRange(i: Pick<RegisterIncident, "created_at">, range: Range): boolean {
  const day = i.created_at.slice(0, 10);
  if (range.from && day < range.from) return false;
  if (range.to && day > range.to) return false;
  return true;
}

export function parseRange(params: URLSearchParams): { ok: true; range: Range } | { ok: false; error: string } {
  const get = (k: string) => {
    const v = params.get(k);
    return v && v.trim() ? v.trim() : null;
  };
  const from = get("from");
  const to = get("to");
  for (const [name, v] of [["from", from], ["to", to]] as const) {
    if (v && (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v)))) return { ok: false, error: `"${name}" must be a date like 2026-01-31.` };
  }
  if (from && to && to < from) return { ok: false, error: "The end date is before the start date." };
  return { ok: true, range: { from, to } };
}

export function referenceOf(i: Pick<RegisterIncident, "created_at" | "incident_number">): string {
  return `INC-${new Date(i.created_at).getUTCFullYear()}-${i.incident_number}`;
}

// ---- CSV --------------------------------------------------------------------------------------------------------

/**
 * One CSV cell. Quotes when needed, and defuses spreadsheet formulas: a cell that starts with = + - @ (or a tab or return) would run as a formula when the
 * file is opened in Excel, so it is prefixed with an apostrophe. Reports hold text typed by people, so this matters.
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const REGISTER_COLUMNS = ["Reference", "Raised", "Closed", "Category", "Severity", "Status", "Title", "Activity", "Venue", "People named", "Flags", "Source", "Test"] as const;

export function registerCsv(rows: readonly RegisterIncident[], names: { category: (code: string) => string; severity: (slug: string) => string }): string {
  const lines = [REGISTER_COLUMNS.join(",")];
  for (const i of rows) {
    lines.push(
      [
        referenceOf(i),
        i.created_at.slice(0, 10),
        i.closed_at ? i.closed_at.slice(0, 10) : "",
        names.category(i.incident_type),
        names.severity(i.severity),
        i.status,
        i.title,
        i.activity?.name ?? "",
        i.activity?.venue ?? "",
        i.involved_count ?? "",
        (i.incident_flags ?? []).join(" "),
        i.source ?? "halo",
        i.is_test ? "yes" : "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

// ---- trends -----------------------------------------------------------------------------------------------------

export interface Trends {
  total: number;
  byMonth: { month: string; count: number }[];
  byCategory: { code: string; count: number }[];
  bySeverity: { slug: string; count: number }[];
  byActivity: { name: string; count: number }[];
  /** Places where the same thing keeps happening: three or more incidents at the same activity or venue within 90 days. */
  repeatHazards: { place: string; count: number; latest: string }[];
}

function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

export function buildTrends(rows: readonly RegisterIncident[], now: Date, months = 12): Trends {
  const real = rows.filter((r) => !r.is_test);
  const keys: string[] = [];
  for (let k = months - 1; k >= 0; k--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1));
    keys.push(d.toISOString().slice(0, 7));
  }
  const month = new Map(keys.map((k) => [k, 0]));
  const cat = new Map<string, number>();
  const sev = new Map<string, number>();
  const act = new Map<string, number>();
  for (const r of real) {
    const m = monthKey(r.created_at);
    if (month.has(m)) month.set(m, (month.get(m) ?? 0) + 1);
    cat.set(r.incident_type, (cat.get(r.incident_type) ?? 0) + 1);
    sev.set(r.severity, (sev.get(r.severity) ?? 0) + 1);
    const name = r.activity?.name?.trim();
    if (name) act.set(name, (act.get(name) ?? 0) + 1);
  }
  const sorted = <T extends { count: number }>(a: T[]) => a.sort((x, y) => y.count - x.count);

  // Repeat hazards: group by place (venue when given, else the activity name) in the last 90 days.
  const cutoff = now.getTime() - 90 * 86_400_000;
  const places = new Map<string, { count: number; latest: string }>();
  for (const r of real) {
    if (new Date(r.created_at).getTime() < cutoff) continue;
    const place = (r.activity?.venue || r.activity?.name || "").trim();
    if (!place) continue;
    const cur = places.get(place) ?? { count: 0, latest: r.created_at };
    cur.count += 1;
    if (r.created_at > cur.latest) cur.latest = r.created_at;
    places.set(place, cur);
  }

  return {
    total: real.length,
    byMonth: keys.map((k) => ({ month: k, count: month.get(k) ?? 0 })),
    byCategory: sorted([...cat.entries()].map(([code, count]) => ({ code, count }))),
    bySeverity: [...sev.entries()].map(([slug, count]) => ({ slug, count })).sort((a, b) => severityRank(a.slug) - severityRank(b.slug)),
    byActivity: sorted([...act.entries()].map(([name, count]) => ({ name, count }))).slice(0, 10),
    repeatHazards: sorted([...places.entries()].filter(([, v]) => v.count >= 3).map(([place, v]) => ({ place, count: v.count, latest: v.latest.slice(0, 10) }))),
  };
}
