import { describe, expect, it } from "vitest";

import { AGEING_BUCKETS, CSV_COLUMNS, REPORT_CAP, ageingBucket, buildCsv, buildReport, daysToComplete, outcomeOf, stat, type ReportRow } from "./reports";
import { REQUEST_STATUSES } from "./types";

// The report's definitions, each with a worked example: what counts as within the target, who counts as open, how the median is taken, what the export
// holds and never holds.

const NOW = Date.parse("2026-10-13T00:00:00Z");
const day = (n: number) => new Date(Date.parse("2026-09-01T00:00:00Z") + n * 86_400_000).toISOString();
const ago = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const closure = (over: Partial<ReportRow> = {}): ReportRow => ({
  reference: "CMP-2026-000001",
  type_key: "closure",
  source: "form",
  status: "completed",
  received_at: day(0),
  target_due_at: day(14),
  hard_stop_at: day(30),
  decided_at: day(2),
  completed_at: day(10),
  closed_at: null,
  signoff: { decision: "approved", by: "u-head" },
  ...over,
});
const withdrawal = (over: Partial<ReportRow> = {}): ReportRow => ({ ...closure({ type_key: "withdrawal", target_due_at: null, hard_stop_at: null, reference: "CMP-2026-000002" }), ...over });

const report = (rows: ReportRow[]) => buildReport(rows, NOW, { filters: { from: null, to: null, type: null } });

describe("stat", () => {
  it("averages and takes the median of an odd and an even count, to one decimal", () => {
    expect(stat([])).toEqual({ count: 0, average: null, median: null });
    expect(stat([4])).toEqual({ count: 1, average: 4, median: 4 });
    expect(stat([1, 2, 9])).toEqual({ count: 3, average: 4, median: 2 });
    expect(stat([1, 2, 3, 10])).toEqual({ count: 4, average: 4, median: 2.5 });
    expect(stat([0.25, 0.5])).toEqual({ count: 2, average: 0.4, median: 0.4 });
  });
});

describe("counts by type and status", () => {
  it("counts each type and status, biggest type first, every status present", () => {
    const r = report([closure(), closure({ reference: "b", status: "rejected" }), closure({ reference: "c", status: "received" }), withdrawal()]);
    expect(r.total).toBe(4);
    expect(r.byType.map((t) => [t.key, t.total])).toEqual([["closure", 3], ["withdrawal", 1]]);
    expect(Object.keys(r.byType[0].byStatus).sort()).toEqual([...REQUEST_STATUSES].sort());
    expect(r.byType[0].byStatus).toMatchObject({ completed: 1, rejected: 1, received: 1, closed: 0 });
  });

  it("counts a case as open until it is completed or closed (a rejected case waiting to be closed is still open)", () => {
    const r = report([closure({ status: "completed" }), closure({ status: "closed" }), closure({ status: "rejected" }), closure({ status: "executing" }), closure({ status: "received" })]);
    expect(r).toMatchObject({ total: 5, open: 3, finished: 2 });
  });
});

describe("the clock against the target and the stop", () => {
  it("sorts completed cases into within the target, after it but within the stop, and after the stop", () => {
    const r = report([
      closure({ completed_at: day(14) }), // on the target day: within
      closure({ completed_at: day(14.5) }),
      closure({ completed_at: day(30) }),
      closure({ completed_at: day(31) }),
    ]);
    expect(r.clock).toEqual({ considered: 4, withinTarget: 1, afterTarget: 2, afterStop: 1, openPastStop: 0 });
  });

  it("counts a case still open past its stop, but not one still inside its time, nor a rejected one waiting to be closed", () => {
    const old = (n: number, over: Partial<ReportRow> = {}) => closure({ status: "officer_review", completed_at: null, received_at: ago(n), target_due_at: ago(n - 14), hard_stop_at: ago(n - 30), ...over });
    const r = report([old(40), old(10), old(40, { status: "rejected" }), old(40, { status: "closed" })]);
    // only the one case past its stop is classified: the one still inside its time is neither late nor on time yet
    expect(r.clock).toEqual({ considered: 1, withinTarget: 0, afterTarget: 0, afterStop: 0, openPastStop: 1 });
  });

  it("ignores types that have no clock", () => {
    expect(report([withdrawal()]).clock.considered).toBe(0);
  });
});

describe("the days to a decision and to completion", () => {
  it("measures from the request, in days with a decimal, over the cases that have the date", () => {
    const r = report([
      closure({ decided_at: day(2), completed_at: day(10) }),
      closure({ decided_at: day(4), completed_at: day(12) }),
      closure({ decided_at: day(9), completed_at: null, status: "approved" }),
      closure({ decided_at: null, completed_at: null, status: "received" }),
    ]);
    expect(r.timing.toDecision).toEqual({ count: 3, average: 5, median: 4 });
    expect(r.timing.toCompletion).toEqual({ count: 2, average: 11, median: 11 });
  });

  it("leaves out a date before the request (bad data) rather than a negative number", () => {
    const r = report([closure({ decided_at: day(-3) })]);
    expect(r.timing.toDecision.count).toBe(0);
  });
});

describe("sign-offs and rejections", () => {
  it("counts approvals and rejections by the person who signed, busiest first", () => {
    const r = report([
      closure({ signoff: { decision: "approved", by: "u-head" } }),
      closure({ signoff: { decision: "approved", by: "u-head" } }),
      closure({ signoff: { decision: "rejected", by: "u-head", reason_category: "identity_failed" } }),
      closure({ signoff: { decision: "approved", by: "u-owner" } }),
      closure({ signoff: {}, status: "received" }),
    ]);
    expect(r.signoffs).toEqual([
      { by: "u-head", approved: 2, rejected: 1 },
      { by: "u-owner", approved: 1, rejected: 0 },
    ]);
  });

  it("groups rejections by the category the Head chose; one without a category is 'uncategorised'", () => {
    const rej = (c: unknown) => closure({ status: "rejected", signoff: { decision: "rejected", by: "u", reason_category: c } });
    const r = report([rej("identity_failed"), rej("identity_failed"), rej("duplicate"), rej(undefined), rej("something odd"), closure()]);
    expect(r.rejections).toEqual([
      { category: "identity_failed", count: 2 },
      { category: "uncategorised", count: 2 },
      { category: "duplicate", count: 1 },
    ]);
  });
});

describe("ageing of the open cases", () => {
  it("puts each open case in 0 to 7, 8 to 14, 15 to 30 or over 30 days, and counts no finished case", () => {
    expect(ageingBucket(ago(0), NOW)).toBe("d0_7");
    expect(ageingBucket(ago(7.9), NOW)).toBe("d0_7");
    expect(ageingBucket(ago(8), NOW)).toBe("d8_14");
    expect(ageingBucket(ago(14.5), NOW)).toBe("d8_14");
    expect(ageingBucket(ago(15), NOW)).toBe("d15_30");
    expect(ageingBucket(ago(30.9), NOW)).toBe("d15_30");
    expect(ageingBucket(ago(31), NOW)).toBe("d31_plus");
    expect(ageingBucket(day(400), NOW)).toBe("d0_7"); // a date in the future is not older than today
    const r = report([
      closure({ status: "received", received_at: ago(1) }),
      closure({ status: "officer_review", received_at: ago(9) }),
      closure({ status: "awaiting_signoff", received_at: ago(20) }),
      closure({ status: "executing", received_at: ago(45) }),
      closure({ status: "executing", received_at: ago(50) }),
      closure({ status: "completed", received_at: ago(90) }),
    ]);
    expect(r.ageing).toEqual([
      { bucket: "d0_7", count: 1 },
      { bucket: "d8_14", count: 1 },
      { bucket: "d15_30", count: 1 },
      { bucket: "d31_plus", count: 2 },
    ]);
    expect(r.ageing.map((a) => a.bucket)).toEqual([...AGEING_BUCKETS]);
  });
});

describe("the report as a whole", () => {
  it("is empty and well-formed for no cases", () => {
    const r = report([]);
    expect(r).toMatchObject({ total: 0, open: 0, finished: 0, byType: [], signoffs: [], rejections: [], truncated: false });
    expect(r.timing.toDecision.average).toBeNull();
    expect(r.ageing.every((a) => a.count === 0)).toBe(true);
  });

  it("carries the filters, the time it was made and whether it was cut short", () => {
    const r = buildReport([], NOW, { filters: { from: "a", to: "b", type: "closure" }, truncated: true });
    expect(r).toMatchObject({ filters: { from: "a", to: "b", type: "closure" }, generatedAt: new Date(NOW).toISOString(), truncated: true });
  });

  it("is the same for the same rows and the same clock", () => {
    const rows = [closure(), withdrawal(), closure({ status: "received" })];
    expect(report(rows)).toEqual(report(rows));
  });
});

describe("the CSV", () => {
  it("has the agreed columns, one row per case, the dates as UTC instants, the days to complete and the outcome", () => {
    const csv = buildCsv([closure({ reference: "CMP-2026-000101" })], (k) => (k === "closure" ? "Account closure" : k));
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    expect(lines[0]).toBe("reference,type,source,status,received_at,target_due_at,hard_stop_at,decided_at,completed_at,days_to_complete,outcome");
    expect(lines[1]).toBe("CMP-2026-000101,Account closure,form,completed,2026-09-01T00:00:00.000Z,2026-09-15T00:00:00.000Z,2026-10-01T00:00:00.000Z,2026-09-03T00:00:00.000Z,2026-09-11T00:00:00.000Z,10,completed");
    expect(lines[2]).toBe("");
  });

  it("holds no name, phone number, email address, bank detail, reason or note: only what the row has", () => {
    const row = { ...closure(), customer_name: "Siti Aminah", customer_email: "siti@example.test", customer_phone: "+60123456789", data: { bank: "8800123456789012" }, outcome_reason: "private" } as ReportRow;
    const csv = buildCsv([row]);
    for (const bad of ["Siti", "example.test", "+6012", "8800", "private"]) expect(csv).not.toContain(bad);
  });

  it("makes a cell that starts like a formula harmless and quotes a comma", () => {
    const csv = buildCsv([closure({ reference: "=HYPERLINK(1)" })], () => "Closure, special");
    expect(csv).toContain("'=HYPERLINK(1)");
    expect(csv).toContain('"Closure, special"');
  });

  it("stops at the cap", () => {
    const rows = Array.from({ length: REPORT_CAP + 10 }, (_, i) => closure({ reference: `R${i}` }));
    expect(buildCsv(rows).split("\r\n").filter(Boolean)).toHaveLength(REPORT_CAP + 1);
  });

  it("says how each case ended, in one word", () => {
    expect(outcomeOf({ status: "received", completed_at: null, signoff: {} })).toBe("open");
    expect(outcomeOf({ status: "awaiting_signoff", completed_at: null, signoff: {} })).toBe("open");
    expect(outcomeOf({ status: "executing", completed_at: null, signoff: { decision: "approved" } })).toBe("approved");
    expect(outcomeOf({ status: "rejected", completed_at: null, signoff: { decision: "rejected" } })).toBe("rejected");
    expect(outcomeOf({ status: "closed", completed_at: null, signoff: { decision: "rejected" } })).toBe("rejected");
    expect(outcomeOf({ status: "closed", completed_at: day(5), signoff: { decision: "approved" } })).toBe("completed");
    expect(outcomeOf({ status: "completed", completed_at: day(5), signoff: { decision: "approved" } })).toBe("completed");
    expect(outcomeOf({ status: "closed", completed_at: null, signoff: {} })).toBe("closed_without_decision");
    expect(outcomeOf({ status: "closed", completed_at: null, signoff: null })).toBe("closed_without_decision");
  });

  it("leaves the days blank until the case is complete", () => {
    expect(daysToComplete({ received_at: day(0), completed_at: null })).toBe("");
    expect(daysToComplete({ received_at: day(0), completed_at: day(2.25) })).toBe("2.3");
    expect(daysToComplete({ received_at: day(3), completed_at: day(1) })).toBe("");
  });
});
