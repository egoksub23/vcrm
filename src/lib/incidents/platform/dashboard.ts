// The incident dashboard's filters: what the person picked, how it is kept in the address (so a view can be bookmarked or sent), and which incidents it leaves in.
// Pure, so the rules are tested. The server has already decided which incidents this person may see; filtering only narrows that list.

import type { Incident } from "@/lib/incidents/types";
import { incidentKey } from "@/lib/incidents/types";

export type DashboardView = "board" | "list" | "play";

export interface DashboardFilters {
  q: string;
  status: string[];
  category: string[];
  severity: string[];
  flag: string[];
  /** A person's id, or "none" for incidents with nobody leading them. */
  lead: string;
  /** Incidents I lead or reported. */
  mine: boolean;
  /** Part of the name of a student named on the incident. */
  student: string;
  from: string;
  to: string;
  needs: boolean;
  /** The tiles: not closed, a required step overdue, nobody has acknowledged it yet. */
  open: boolean;
  overdue: boolean;
  unack: boolean;
}

export const NO_LEAD = "none";
export const EMPTY_FILTERS: DashboardFilters = { q: "", status: [], category: [], severity: [], flag: [], lead: "", mine: false, student: "", from: "", to: "", needs: false, open: false, overdue: false, unack: false };

export interface NamedStudent {
  name: string;
  class_name: string | null;
}

export interface FilterContext {
  me: string | null;
  /** Students named on each incident, keyed by incident id. */
  involved: Readonly<Record<string, readonly NamedStudent[]>>;
  needsIds: ReadonlySet<string>;
  overdueIds: ReadonlySet<string>;
  unackIds: ReadonlySet<string>;
}

type Params = { get(name: string): string | null };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const list = (v: string | null): string[] => (v ? [...new Set(v.split(",").map((x) => x.trim()).filter(Boolean))] : []);

export function parseView(params: Params, canSeePlay: boolean): DashboardView {
  const v = params.get("view");
  if (v === "play" && canSeePlay) return "play";
  return v === "list" ? "list" : "board";
}

export function parseFilters(params: Params): DashboardFilters {
  const date = (v: string | null) => (v && DATE.test(v) ? v : "");
  return {
    q: (params.get("q") ?? "").slice(0, 200),
    status: list(params.get("status")),
    category: list(params.get("category")),
    severity: list(params.get("severity")),
    flag: list(params.get("flag")),
    lead: (params.get("lead") ?? "").slice(0, 64),
    mine: params.get("mine") === "1",
    student: (params.get("student") ?? "").slice(0, 100),
    from: date(params.get("from")),
    to: date(params.get("to")),
    needs: params.get("needs") === "1",
    open: params.get("open") === "1",
    overdue: params.get("overdue") === "1",
    unack: params.get("unack") === "1",
  };
}

/** The address parameters for a set of filters and a view; anything left at its default is left out. */
export function toParams(f: DashboardFilters, view: DashboardView): URLSearchParams {
  const p = new URLSearchParams();
  if (view !== "board") p.set("view", view);
  if (f.q.trim()) p.set("q", f.q.trim());
  if (f.status.length) p.set("status", f.status.join(","));
  if (f.category.length) p.set("category", f.category.join(","));
  if (f.severity.length) p.set("severity", f.severity.join(","));
  if (f.flag.length) p.set("flag", f.flag.join(","));
  if (f.lead) p.set("lead", f.lead);
  if (f.mine) p.set("mine", "1");
  if (f.student.trim()) p.set("student", f.student.trim());
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.needs) p.set("needs", "1");
  if (f.open) p.set("open", "1");
  if (f.overdue) p.set("overdue", "1");
  if (f.unack) p.set("unack", "1");
  return p;
}

/** How many filters are on (the search box counts), for the "Clear" button. */
export function activeCount(f: DashboardFilters): number {
  return (
    (f.q.trim() ? 1 : 0) + (f.status.length ? 1 : 0) + (f.category.length ? 1 : 0) + (f.severity.length ? 1 : 0) + (f.flag.length ? 1 : 0) + (f.lead ? 1 : 0) +
    (f.mine ? 1 : 0) + (f.student.trim() ? 1 : 0) + (f.from ? 1 : 0) + (f.to ? 1 : 0) + (f.needs ? 1 : 0) + (f.open ? 1 : 0) + (f.overdue ? 1 : 0) + (f.unack ? 1 : 0)
  );
}

export function toggle(values: readonly string[], value: string): string[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

export function applyFilters(rows: readonly Incident[], f: DashboardFilters, ctx: FilterContext): Incident[] {
  const q = f.q.trim().toLowerCase();
  const student = f.student.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.status.length && !f.status.includes(r.status)) return false;
    if (f.category.length && !f.category.includes(r.incident_type)) return false;
    if (f.severity.length && !f.severity.includes(r.severity)) return false;
    if (f.flag.length && !f.flag.some((x) => (r.incident_flags ?? []).includes(x))) return false;
    if (f.lead === NO_LEAD && r.incident_lead_id) return false;
    if (f.lead && f.lead !== NO_LEAD && r.incident_lead_id !== f.lead) return false;
    if (f.mine && !(ctx.me && (r.incident_lead_id === ctx.me || r.reporter_id === ctx.me))) return false;
    if (f.needs && !ctx.needsIds.has(r.id)) return false;
    if (f.open && r.status === "closed") return false;
    if (f.overdue && !ctx.overdueIds.has(r.id)) return false;
    if (f.unack && !ctx.unackIds.has(r.id)) return false;
    const day = r.created_at.slice(0, 10);
    if (f.from && day < f.from) return false;
    if (f.to && day > f.to) return false;
    if (student && !(ctx.involved[r.id] ?? []).some((s) => s.name.toLowerCase().includes(student))) return false;
    // Search matches the title, the reference, and the activity or place it happened at.
    const where = (r as { activity?: { name?: string; venue?: string } | null }).activity;
    if (q && !r.title.toLowerCase().includes(q) && !incidentKey(r).toLowerCase().includes(q) && !`${where?.name ?? ""} ${where?.venue ?? ""}`.toLowerCase().includes(q)) return false;
    return true;
  });
}
