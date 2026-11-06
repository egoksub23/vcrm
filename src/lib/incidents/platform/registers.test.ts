import { describe, expect, it } from "vitest";

import { buildTrends, csvCell, inRange, inRegister, isRegister, parseRange, referenceOf, registerCsv, type RegisterIncident } from "./registers";

const NOW = new Date("2026-11-11T10:00:00Z");
const cats = [{ code: "CCA", name: "CCA / sports injury" }, { code: "NMS", name: "Near miss" }, { code: "DBR", name: "Data breach" }];
const inc = (n: number, over: Partial<RegisterIncident> = {}): RegisterIncident => ({
  id: `i${n}`,
  incident_number: n,
  created_at: "2026-11-05T10:00:00Z",
  closed_at: null,
  title: `Incident ${n}`,
  incident_type: "CCA",
  severity: "medium",
  status: "reported",
  incident_flags: ["injury"],
  ...over,
});

describe("registers", () => {
  it("files an incident under every register it belongs to", () => {
    const both = inc(1, { incident_flags: ["injury", "personal_data"] });
    expect(inRegister(both, "injury", cats)).toBe(true);
    expect(inRegister(both, "breach", cats)).toBe(true);
    expect(inRegister(both, "property", cats)).toBe(false);
    expect(inRegister(both, "all", cats)).toBe(true);
    expect(inRegister(inc(2, { incident_type: "NMS", incident_flags: [] }), "near_miss", cats)).toBe(true);
    expect(inRegister(inc(3, { incident_flags: null }), "injury", cats)).toBe(false);
    expect(inRegister(inc(4, { incident_flags: ["safeguarding"] }), "safeguarding", cats)).toBe(true);
  });
  it("knows its register names", () => {
    expect(isRegister("breach")).toBe(true);
    expect(isRegister("everything")).toBe(false);
  });
  it("filters by an inclusive date range", () => {
    const r = { from: "2026-11-05", to: "2026-11-05" };
    expect(inRange(inc(1), r)).toBe(true);
    expect(inRange(inc(1, { created_at: "2026-11-06T00:00:00Z" }), r)).toBe(false);
    expect(inRange(inc(1), { from: null, to: null })).toBe(true);
  });
  it("reads a range from the query and explains a bad one", () => {
    expect(parseRange(new URLSearchParams("from=2026-01-01&to=2026-03-31"))).toEqual({ ok: true, range: { from: "2026-01-01", to: "2026-03-31" } });
    expect(parseRange(new URLSearchParams(""))).toEqual({ ok: true, range: { from: null, to: null } });
    expect(parseRange(new URLSearchParams("from=Jan"))).toMatchObject({ ok: false });
    expect(parseRange(new URLSearchParams("from=2026-03-01&to=2026-01-01"))).toMatchObject({ ok: false });
  });
  it("writes the reference as the screens do", () => {
    expect(referenceOf(inc(31))).toBe("INC-2026-31");
  });
});

describe("CSV", () => {
  it("quotes cells that need it", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(5)).toBe("5");
  });
  it("defuses spreadsheet formulas typed into a report", () => {
    for (const bad of ["=SUM(A1)", "+1", "-1", "@cmd", "\tX", "=HYPERLINK(\"http://x\")"]) expect(csvCell(bad).replace(/^"/, "").startsWith("'")).toBe(true);
    expect(csvCell("a=b")).toBe("a=b");
  });
  it("builds the register file with a header and one row per incident", () => {
    const csv = registerCsv([inc(31, { closed_at: "2026-11-09T00:00:00Z", activity: { name: "Football U15", venue: "Field 2" }, involved_count: 2, source: "coach_portal", title: "=cmd" })], { category: () => "CCA / sports injury", severity: () => "Serious" });
    const [header, row] = csv.trim().split("\r\n");
    expect(header).toBe("Reference,Raised,Closed,Category,Severity,Status,Title,Activity,Venue,People named,Flags,Source,Test");
    expect(row).toBe("INC-2026-31,2026-11-05,2026-11-09,CCA / sports injury,Serious,reported,'=cmd,Football U15,Field 2,2,injury,coach_portal,");
  });
});

describe("trends", () => {
  it("counts by month (a full year, oldest first), category, severity and activity, leaving out tests", () => {
    const rows = [
      inc(1, { activity: { name: "Football U15", venue: "Field 2" } }),
      inc(2, { created_at: "2026-10-20T00:00:00Z", severity: "high", activity: { name: "Football U15", venue: "Field 2" } }),
      inc(3, { incident_type: "NMS", severity: "low" }),
      inc(4, { is_test: true }),
    ];
    const t = buildTrends(rows, NOW);
    expect(t.total).toBe(3);
    expect(t.byMonth).toHaveLength(12);
    expect(t.byMonth.at(-1)).toEqual({ month: "2026-11", count: 2 });
    expect(t.byMonth.at(-2)).toEqual({ month: "2026-10", count: 1 });
    expect(t.byCategory[0]).toEqual({ code: "CCA", count: 2 });
    expect(t.bySeverity.map((s) => s.slug)).toEqual(["high", "medium", "low"]);
    expect(t.byActivity).toEqual([{ name: "Football U15", count: 2 }]);
  });
  it("flags a place where three or more incidents happened in 90 days", () => {
    const rows = [1, 2, 3].map((n) => inc(n, { created_at: `2026-10-0${n}T00:00:00Z`, activity: { name: "Football", venue: "Field 2" } })).concat(inc(9, { created_at: "2026-01-01T00:00:00Z", activity: { name: "Football", venue: "Field 2" } }));
    const t = buildTrends(rows, NOW);
    expect(t.repeatHazards).toEqual([{ place: "Field 2", count: 3, latest: "2026-10-03" }]);
    expect(buildTrends(rows.slice(0, 2), NOW).repeatHazards).toEqual([]);
  });
});
