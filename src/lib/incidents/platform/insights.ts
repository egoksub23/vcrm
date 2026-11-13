// What the Reports page says: not a pile of counts but what to do about them. Pure: incidents, the people named on them and the Dashboard's own "needs
// action" sets in; a short list of things that need attention, a few numbers that mean something, and where and when incidents happen out.
// Every attention item carries the Dashboard address that lists exactly those incidents, so the report leads to the work.

import { severityRank } from "@/lib/incidents/constants";
import type { RegisterIncident } from "./registers";

const DAY = 86_400_000;
export const STALE_DAYS = 14;
export const RECENT_DAYS = 30;
export const REPEAT_DAYS = 90;
export const REPEAT_PLACE_MIN = 3;
export const REPEAT_STUDENT_MIN = 2;
export const REPEAT_ACTIVITY_TYPE_MIN = 3;
export const REPEAT_TIME_BAND_MIN = 3;

export interface InsightIncident extends RegisterIncident {
  standard_id?: string | null;
}
export interface InsightPerson {
  incident_id: string;
  name: string;
  class_name: string | null;
}
export interface NamesFor {
  category: (code: string, standardId: string | null | undefined) => string;
  severity: (slug: string, standardId: string | null | undefined) => string;
}

export type Attention =
  | { kind: "overdue"; count: number; href: string }
  | { kind: "unacknowledged"; count: number; href: string }
  | { kind: "stale"; count: number; days: number; href: string }
  | { kind: "seriousOpen"; count: number; href: string }
  | { kind: "repeatStudent"; name: string; count: number; href: string }
  | { kind: "repeatPlace"; place: string; count: number; latest: string; href: string }
  | { kind: "rising"; recent: number; previous: number; href: string }
  | { kind: "repeatActivityType"; category: string; count: number; href: string }
  | { kind: "repeatTimeOfDay"; band: string; count: number; href: string };

export interface Share {
  key: string;
  label: string;
  count: number;
  /** 0 to 1, of all incidents in the period. */
  share: number;
}

export interface Insights {
  total: number;
  raisedRecent: number;
  raisedBefore: number;
  open: number;
  closed: number;
  /** Median days from raised to closed, over incidents closed in the period; null when none has been closed. */
  medianDaysToClose: number | null;
  attention: Attention[];
  byCategory: Share[];
  bySeverity: Share[];
  byPlace: Share[];
  /** Months from the first month with an incident (at least three months shown), so a school's first weeks are not twelve empty bars. */
  byMonth: { month: string; count: number }[];
}

const isOpen = (r: { status: string }) => r.status !== "closed";
const q = (params: Record<string, string>) => `/incidents?${new URLSearchParams(params).toString()}`;

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function shares(counts: Map<string, { label: string; count: number }>, total: number, limit = 8): Share[] {
  return [...counts.entries()]
    .map(([key, v]) => ({ key, label: v.label, count: v.count, share: total > 0 ? v.count / total : 0 }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
}

export function buildInsights(args: {
  rows: readonly InsightIncident[];
  people: readonly InsightPerson[];
  overdueIds: ReadonlySet<string>;
  unackIds: ReadonlySet<string>;
  names: NamesFor;
  now: Date;
  months?: number;
}): Insights {
  const { people, overdueIds, unackIds, names, now } = args;
  const months = args.months ?? 12;
  const nowMs = now.getTime();
  const rows = args.rows.filter((r) => !r.is_test);

  const recentFrom = nowMs - RECENT_DAYS * DAY;
  const beforeFrom = nowMs - 2 * RECENT_DAYS * DAY;
  let raisedRecent = 0;
  let raisedBefore = 0;
  const cat = new Map<string, { label: string; count: number }>();
  const sev = new Map<string, { label: string; count: number }>();
  const place = new Map<string, { label: string; count: number }>();
  const monthCount = new Map<string, number>();
  const closeDays: number[] = [];

  for (const r of rows) {
    const t = new Date(r.created_at).getTime();
    if (t >= recentFrom) raisedRecent += 1;
    else if (t >= beforeFrom) raisedBefore += 1;

    const cname = names.category(r.incident_type, r.standard_id);
    const c = cat.get(cname) ?? { label: cname, count: 0 };
    c.count += 1;
    cat.set(cname, c);
    const sname = names.severity(r.severity, r.standard_id);
    const s = sev.get(r.severity) ?? { label: sname, count: 0 };
    s.count += 1;
    sev.set(r.severity, s);
    const p = (r.activity?.venue || r.activity?.name || "").trim();
    if (p) {
      const pe = place.get(p.toLowerCase()) ?? { label: p, count: 0 };
      pe.count += 1;
      place.set(p.toLowerCase(), pe);
    }
    monthCount.set(r.created_at.slice(0, 7), (monthCount.get(r.created_at.slice(0, 7)) ?? 0) + 1);
    if (r.closed_at) {
      const d = (new Date(r.closed_at).getTime() - t) / DAY;
      if (d >= 0) closeDays.push(d);
    }
  }

  const total = rows.length;
  const open = rows.filter(isOpen).length;
  const med = median(closeDays);

  // ---- what needs attention ------------------------------------------------------------------------------------
  const attention: Attention[] = [];
  const openRows = rows.filter(isOpen);
  const overdue = openRows.filter((r) => overdueIds.has(r.id)).length;
  if (overdue > 0) attention.push({ kind: "overdue", count: overdue, href: q({ overdue: "1" }) });
  const unack = openRows.filter((r) => unackIds.has(r.id)).length;
  if (unack > 0) attention.push({ kind: "unacknowledged", count: unack, href: q({ unack: "1" }) });
  const seriousOpen = openRows.filter((r) => severityRank(r.severity) <= 1).length;
  if (seriousOpen > 0) attention.push({ kind: "seriousOpen", count: seriousOpen, href: q({ open: "1" }) });
  const stale = openRows.filter((r) => nowMs - new Date(r.created_at).getTime() >= STALE_DAYS * DAY).length;
  if (stale > 0) attention.push({ kind: "stale", count: stale, days: STALE_DAYS, href: q({ open: "1" }) });

  // The same student named again and again.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const repeatFrom = nowMs - REPEAT_DAYS * DAY;
  const perStudent = new Map<string, { name: string; ids: Set<string> }>();
  for (const p of people) {
    const inc = byId.get(p.incident_id);
    if (!inc || new Date(inc.created_at).getTime() < repeatFrom) continue;
    const key = `${p.name.trim().toLowerCase()}|${(p.class_name ?? "").trim().toLowerCase()}`;
    const e = perStudent.get(key) ?? { name: p.name.trim(), ids: new Set<string>() };
    e.ids.add(p.incident_id);
    perStudent.set(key, e);
  }
  for (const e of [...perStudent.values()].filter((x) => x.ids.size >= REPEAT_STUDENT_MIN).sort((a, b) => b.ids.size - a.ids.size).slice(0, 5)) {
    attention.push({ kind: "repeatStudent", name: e.name, count: e.ids.size, href: q({ student: e.name }) });
  }

  // The same place again and again.
  const perPlace = new Map<string, { place: string; count: number; latest: string }>();
  for (const r of rows) {
    if (new Date(r.created_at).getTime() < repeatFrom) continue;
    const pl = (r.activity?.venue || r.activity?.name || "").trim();
    if (!pl) continue;
    const e = perPlace.get(pl.toLowerCase()) ?? { place: pl, count: 0, latest: r.created_at };
    e.count += 1;
    if (r.created_at > e.latest) e.latest = r.created_at;
    perPlace.set(pl.toLowerCase(), e);
  }
  for (const e of [...perPlace.values()].filter((x) => x.count >= REPEAT_PLACE_MIN).sort((a, b) => b.count - a.count).slice(0, 5)) {
    attention.push({ kind: "repeatPlace", place: e.place, count: e.count, latest: e.latest.slice(0, 10), href: q({ q: e.place }) });
  }

  // The same incident category keeps recurring.
  const perType = new Map<string, { label: string; count: number }>();
  for (const r of rows) {
    if (new Date(r.created_at).getTime() < repeatFrom) continue;
    const label = names.category(r.incident_type, r.standard_id);
    const e = perType.get(r.incident_type) ?? { label, count: 0 };
    e.count += 1;
    perType.set(r.incident_type, e);
  }
  for (const e of [...perType.values()].filter((x) => x.count >= REPEAT_ACTIVITY_TYPE_MIN).sort((a, b) => b.count - a.count).slice(0, 3)) {
    attention.push({ kind: "repeatActivityType", category: e.label, count: e.count, href: q({ type: e.label }) });
  }

  // Incidents clustering in the same time-of-day band.
  const bandLabel = (hour: number): string => {
    if (hour < 7) return "before 07:00";
    if (hour < 10) return "07:00–10:00";
    if (hour < 13) return "10:00–13:00";
    if (hour < 16) return "13:00–16:00";
    if (hour < 19) return "16:00–19:00";
    return "after 19:00";
  };
  const perBand = new Map<string, number>();
  for (const r of rows) {
    if (new Date(r.created_at).getTime() < repeatFrom) continue;
    const timeStr = r.activity?.time ?? r.occurred_at ?? null;
    if (!timeStr) continue;
    let hour: number | null = null;
    if (/^\d{2}:\d{2}/.test(timeStr)) hour = parseInt(timeStr.slice(0, 2), 10);
    else {
      const d = new Date(timeStr);
      if (!Number.isNaN(d.getTime())) hour = d.getUTCHours();
    }
    if (hour === null) continue;
    const band = bandLabel(hour);
    perBand.set(band, (perBand.get(band) ?? 0) + 1);
  }
  for (const [band, count] of [...perBand.entries()].filter(([, c]) => c >= REPEAT_TIME_BAND_MIN).sort((a, b) => b[1] - a[1]).slice(0, 2)) {
    attention.push({ kind: "repeatTimeOfDay", band, count, href: q({ open: "1" }) });
  }

  if (raisedRecent >= 3 && raisedRecent >= raisedBefore * 1.5) attention.push({ kind: "rising", recent: raisedRecent, previous: raisedBefore, href: q({ from: new Date(recentFrom).toISOString().slice(0, 10) }) });

  // ---- when ----------------------------------------------------------------------------------------------------
  const keys: string[] = [];
  for (let k = months - 1; k >= 0; k--) keys.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1)).toISOString().slice(0, 7));
  const firstWithData = keys.findIndex((k) => (monthCount.get(k) ?? 0) > 0);
  const startAt = firstWithData < 0 ? keys.length - 3 : Math.min(firstWithData, keys.length - 3);

  return {
    total,
    raisedRecent,
    raisedBefore,
    open,
    closed: total - open,
    medianDaysToClose: med === null ? null : Math.round(med * 10) / 10,
    attention,
    byCategory: shares(cat, total),
    bySeverity: [...sev.entries()]
      .map(([slug, v]) => ({ key: slug, label: v.label, count: v.count, share: total > 0 ? v.count / total : 0 }))
      .sort((a, b) => severityRank(a.key) - severityRank(b.key)),
    byPlace: shares(place, total, 6),
    byMonth: keys.slice(startAt).map((k) => ({ month: k, count: monthCount.get(k) ?? 0 })),
  };
}
