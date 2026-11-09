import { describe, expect, it } from "vitest";

import { buildInsights, median, type InsightIncident } from "./insights";

const NOW = new Date("2026-11-09T04:00:00.000Z");
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

let n = 0;
function inc(over: Partial<InsightIncident> = {}): InsightIncident {
  n += 1;
  return { id: `i${n}`, incident_number: n, created_at: day(5), closed_at: null, title: `Incident ${n}`, incident_type: "CCA", severity: "medium", status: "reported", incident_flags: [], standard_id: "s1", ...over };
}
const names = {
  category: (code: string) => ({ CCA: "CCA injury", AT: "Account takeover" })[code] ?? code,
  severity: (slug: string) => ({ critical: "Critical", high: "Serious", medium: "Moderate", low: "Minor" })[slug] ?? slug,
};
const run = (rows: InsightIncident[], extra: Partial<Parameters<typeof buildInsights>[0]> = {}) =>
  buildInsights({ rows, people: [], overdueIds: new Set(), unackIds: new Set(), names, now: NOW, ...extra });

describe("median", () => {
  it("handles none, odd and even", () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 10])).toBe(2.5);
  });
});

describe("buildInsights", () => {
  it("says nothing needs attention when nothing does", () => {
    const r = run([inc({ status: "closed", closed_at: day(2) })]);
    expect(r.attention).toEqual([]);
    expect(r.open).toBe(0);
    expect(r.closed).toBe(1);
  });

  it("leaves test reports out of everything", () => {
    const r = run([inc({ is_test: true }), inc()]);
    expect(r.total).toBe(1);
  });

  it("flags overdue steps, unacknowledged incidents and serious ones still open, each with the Dashboard address that lists them", () => {
    const a = inc({ severity: "critical" });
    const b = inc();
    const closedOne = inc({ status: "closed", closed_at: day(1) });
    const r = run([a, b, closedOne], { overdueIds: new Set([a.id, closedOne.id]), unackIds: new Set([b.id]) });
    expect(r.attention).toContainEqual({ kind: "overdue", count: 1, href: "/incidents?overdue=1" }); // the closed one does not count
    expect(r.attention).toContainEqual({ kind: "unacknowledged", count: 1, href: "/incidents?unack=1" });
    expect(r.attention).toContainEqual({ kind: "seriousOpen", count: 1, href: "/incidents?open=1" });
  });

  it("flags incidents left open for two weeks or more", () => {
    const r = run([inc({ created_at: day(20) }), inc({ created_at: day(3) })]);
    expect(r.attention).toContainEqual({ kind: "stale", count: 1, days: 14, href: "/incidents?open=1" });
  });

  it("flags a student named on two or more incidents in 90 days, matching names without caring about case", () => {
    const a = inc();
    const b = inc({ created_at: day(40) });
    const old = inc({ created_at: day(200) });
    const r = run([a, b, old], {
      people: [
        { incident_id: a.id, name: "Arvin Raj", class_name: "2E" },
        { incident_id: b.id, name: "arvin raj ", class_name: "2e" },
        { incident_id: old.id, name: "Arvin Raj", class_name: "2E" },
      ],
    });
    expect(r.attention).toContainEqual({ kind: "repeatStudent", name: "Arvin Raj", count: 2, href: "/incidents?student=Arvin+Raj" });
  });

  it("flags a place with three or more incidents in 90 days", () => {
    const at = (d: number) => inc({ created_at: day(d), activity: { venue: "Field 1" } });
    const r = run([at(3), at(10), at(30), inc({ activity: { venue: "Hall" } })]);
    const place = r.attention.find((a) => a.kind === "repeatPlace");
    expect(place).toMatchObject({ kind: "repeatPlace", place: "Field 1", count: 3 });
  });

  it("says when raising is rising: at least three in 30 days and half as many again as the 30 before", () => {
    const rising = run([inc({ created_at: day(2) }), inc({ created_at: day(4) }), inc({ created_at: day(6) }), inc({ created_at: day(40) })]);
    expect(rising.attention).toContainEqual(expect.objectContaining({ kind: "rising", recent: 3, previous: 1 }));
    const steady = run([inc({ created_at: day(2) }), inc({ created_at: day(4) }), inc({ created_at: day(6) }), inc({ created_at: day(40) }), inc({ created_at: day(41) }), inc({ created_at: day(42) })]);
    expect(steady.attention.find((a) => a.kind === "rising")).toBeUndefined();
  });

  it("works out the median time to close from closed incidents only", () => {
    const r = run([inc({ created_at: day(10), closed_at: day(8) }), inc({ created_at: day(10), closed_at: day(4) }), inc({ created_at: day(10), closed_at: day(7) }), inc()]);
    expect(r.medianDaysToClose).toBe(3);
    expect(run([inc()]).medianDaysToClose).toBeNull();
  });

  it("names categories by the template each incident was raised under and gives shares of the whole", () => {
    const r = run([inc({ incident_type: "AT" }), inc({ incident_type: "CCA" }), inc({ incident_type: "CCA" }), inc({ incident_type: "CCA" })]);
    expect(r.byCategory[0]).toEqual({ key: "CCA injury", label: "CCA injury", count: 3, share: 0.75 });
    expect(r.byCategory[1].label).toBe("Account takeover");
  });

  it("orders severities from the most serious", () => {
    const r = run([inc({ severity: "low" }), inc({ severity: "critical" }), inc({ severity: "medium" })]);
    expect(r.bySeverity.map((s) => s.label)).toEqual(["Critical", "Moderate", "Minor"]);
  });

  it("starts the months where the data starts (never fewer than three) instead of twelve empty bars", () => {
    const r = run([inc({ created_at: "2026-09-12T00:00:00.000Z" })]);
    expect(r.byMonth.map((m) => m.month)).toEqual(["2026-09", "2026-10", "2026-11"]);
    expect(r.byMonth[0].count).toBe(1);
    const none = run([]);
    expect(none.byMonth).toHaveLength(3);
    const old = run([inc({ created_at: "2026-01-12T00:00:00.000Z" })]);
    expect(old.byMonth[0].month).toBe("2026-01");
  });
});
