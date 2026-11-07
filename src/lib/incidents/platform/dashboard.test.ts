import { describe, expect, it } from "vitest";

import type { Incident } from "@/lib/incidents/types";
import { activeCount, applyFilters, EMPTY_FILTERS, NO_LEAD, parseFilters, parseView, toggle, toParams, type DashboardFilters, type FilterContext } from "./dashboard";

const inc = (id: string, o: Partial<Incident> = {}): Incident =>
  ({ id, incident_number: Number(id.replace(/\D/g, "")) || 1, title: `Incident ${id}`, incident_type: "CCA", severity: "high", status: "reported", incident_flags: [], incident_lead_id: null, reporter_id: null, created_at: "2026-10-15T08:00:00Z", ...o }) as Incident;

const rows = [
  inc("a1", { title: "Fall in the hall", status: "reported", incident_lead_id: "u-lead", incident_flags: ["injury"] }),
  inc("b2", { title: "Phishing email", incident_type: "DBR", severity: "critical", status: "investigating", reporter_id: "u-me", incident_flags: ["personal_data"], created_at: "2026-09-01T08:00:00Z" }),
  inc("c3", { title: "Broken window", incident_type: "PRP", severity: "low", status: "closed", incident_lead_id: "u-me", created_at: "2026-10-30T08:00:00Z" }),
];
const ctx: FilterContext = { me: "u-me", involved: { a1: [{ name: "Aisha Rahman", class_name: "5 Amanah" }], b2: [] }, needsIds: new Set(["b2"]), overdueIds: new Set(["a1"]), unackIds: new Set(["a1", "b2"]) };
const run = (f: Partial<DashboardFilters>) => applyFilters(rows, { ...EMPTY_FILTERS, ...f }, ctx).map((r) => r.id);

describe("the dashboard filters", () => {
  it("leave everything in when nothing is picked", () => {
    expect(run({})).toEqual(["a1", "b2", "c3"]);
  });
  it("narrow by status, category, severity and flag, each of which accepts several values", () => {
    expect(run({ status: ["reported", "closed"] })).toEqual(["a1", "c3"]);
    expect(run({ category: ["DBR"] })).toEqual(["b2"]);
    expect(run({ severity: ["critical", "low"] })).toEqual(["b2", "c3"]);
    expect(run({ flag: ["injury", "personal_data"] })).toEqual(["a1", "b2"]);
  });
  it("narrow by person: a lead, nobody leading, mine (lead or reporter), and a named student", () => {
    expect(run({ lead: "u-lead" })).toEqual(["a1"]);
    expect(run({ lead: NO_LEAD })).toEqual(["b2"]);
    expect(run({ mine: true })).toEqual(["b2", "c3"]);
    expect(run({ student: "aisha" })).toEqual(["a1"]);
    expect(run({ student: "nobody" })).toEqual([]);
  });
  it("mine matches nothing when the person is not known", () => {
    expect(applyFilters(rows, { ...EMPTY_FILTERS, mine: true }, { ...ctx, me: null })).toEqual([]);
  });
  it("narrow by the day raised, both ends included", () => {
    expect(run({ from: "2026-10-01" })).toEqual(["a1", "c3"]);
    expect(run({ to: "2026-10-15" })).toEqual(["a1", "b2"]);
    expect(run({ from: "2026-10-15", to: "2026-10-15" })).toEqual(["a1"]);
  });
  it("narrow to the incidents that need action, and search the title and the reference", () => {
    expect(run({ needs: true })).toEqual(["b2"]);
    expect(run({ q: "window" })).toEqual(["c3"]);
    expect(run({ q: "inc-2026-1" })).toEqual(["a1"]);
  });
  it("narrow by the tiles: not closed, a step overdue, not yet acknowledged, each on its own or together", () => {
    expect(run({ open: true })).toEqual(["a1", "b2"]);
    expect(run({ overdue: true })).toEqual(["a1"]);
    expect(run({ unack: true })).toEqual(["a1", "b2"]);
    expect(run({ open: true, overdue: true, unack: true })).toEqual(["a1"]);
  });
  it("combine: every filter has to agree", () => {
    expect(run({ mine: true, status: ["closed"] })).toEqual(["c3"]);
    expect(run({ mine: true, status: ["reported"] })).toEqual([]);
  });
});

describe("the dashboard address", () => {
  it("round-trips the filters and the view", () => {
    const f: DashboardFilters = { q: "fall", status: ["reported", "triaged"], category: ["CCA"], severity: ["high"], flag: ["injury"], lead: "u-1", mine: true, student: "Aisha", from: "2026-10-01", to: "2026-10-31", needs: true, open: true, overdue: true, unack: true };
    const p = toParams(f, "list");
    expect(parseFilters(p)).toEqual(f);
    expect(parseView(p, false)).toBe("list");
  });
  it("leaves defaults out, so a plain dashboard has a plain address", () => {
    expect(toParams(EMPTY_FILTERS, "board").toString()).toBe("");
  });
  it("ignores bad dates and shows the nurse's view only to someone who may see it", () => {
    expect(parseFilters(new URLSearchParams("from=yesterday&to=2026-13")).from).toBe("");
    expect(parseView(new URLSearchParams("view=play"), false)).toBe("board");
    expect(parseView(new URLSearchParams("view=play"), true)).toBe("play");
    expect(parseView(new URLSearchParams("view=nonsense"), true)).toBe("board");
  });
  it("counts the filters that are on, and toggles a value", () => {
    expect(activeCount(EMPTY_FILTERS)).toBe(0);
    expect(activeCount({ ...EMPTY_FILTERS, q: " ", status: ["closed"], mine: true })).toBe(2);
    expect(toggle(["a"], "b")).toEqual(["a", "b"]);
    expect(toggle(["a", "b"], "a")).toEqual(["b"]);
  });
});
