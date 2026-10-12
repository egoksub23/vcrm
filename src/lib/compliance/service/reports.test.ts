/* eslint-disable @typescript-eslint/no-explicit-any -- rows are read loosely in a test */
// The reports' queries against the in-memory database: who may read them, the date range and type filters, the workspace wall, the cap, the export that
// is logged first and holds nothing personal, and the sidebar badge count.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FakeDb } from "@/lib/sign/service/fake-db";

import { ComplianceError } from "../errors";
import { REPORT_CAP } from "../reports";
import { ACCOUNT, AGENT, HEAD, OFFICER, OPS, OTHER_ACCOUNT, callerFor, head, officer, ops, world } from "../test-support";
import { badgeCount, exportReportCsv, loadReport, parseReportFilters } from "./reports";

let db: FakeDb;
const NOW = Date.parse("2026-10-13T00:00:00Z");
const NONE = { from: null, to: null, type: null };

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = world();
});

let n = 0;
const add = (over: Record<string, unknown> = {}) => {
  const row = {
    id: `r-${++n}`,
    account_id: ACCOUNT,
    reference: `CMP-2026-${String(n).padStart(6, "0")}`,
    type_key: "closure",
    source: "form",
    status: "received",
    received_at: "2026-09-20T00:00:00.000Z",
    target_due_at: null,
    hard_stop_at: null,
    decided_at: null,
    completed_at: null,
    closed_at: null,
    signoff: {},
    identity_check: {},
    customer_name: "Siti Aminah",
    customer_email: "siti@example.test",
    customer_phone: "+60123456789",
    ...over,
  };
  db.seed("compliance_requests", [row]);
  return row;
};
const fails = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e)) as ComplianceError | null;

describe("loadReport", () => {
  it("is for the officer and the Head, not for operations or anyone else", async () => {
    add();
    expect((await loadReport(db.client(), officer(), NONE, () => NOW)).total).toBe(1);
    expect((await loadReport(db.client(), head(), NONE, () => NOW)).total).toBe(1);
    expect(await fails(loadReport(db.client(), ops(), NONE, () => NOW))).toMatchObject({ code: "forbidden" });
    expect(await fails(loadReport(db.client(), callerFor(AGENT, ["compliance.raise"]), NONE, () => NOW))).toMatchObject({ code: "forbidden" });
  });

  it("reads the cases requested in the range (the start in, the end out) and the type, in this workspace only", async () => {
    add({ received_at: "2026-08-31T23:59:59.000Z" });
    add({ received_at: "2026-09-01T00:00:00.000Z" });
    add({ received_at: "2026-09-30T23:59:59.000Z" });
    add({ received_at: "2026-10-01T00:00:00.000Z" });
    add({ received_at: "2026-09-15T00:00:00.000Z", type_key: "withdrawal" });
    add({ received_at: "2026-09-15T00:00:00.000Z", account_id: OTHER_ACCOUNT });
    const range = { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z", type: null };
    expect((await loadReport(db.client(), head(), range, () => NOW)).total).toBe(3);
    expect((await loadReport(db.client(), head(), { ...range, type: "withdrawal" }, () => NOW)).total).toBe(1);
    expect((await loadReport(db.client(), head(), NONE, () => NOW)).total).toBe(5);
  });

  it("names the people who signed off, 'former member' left to the screen, and carries the types", async () => {
    add({ status: "approved", signoff: { decision: "approved", by: HEAD } });
    add({ status: "rejected", signoff: { decision: "rejected", by: "99999999-9999-4999-8999-999999999999", reason_category: "duplicate" } });
    const r = await loadReport(db.client(), head(), NONE, () => NOW);
    expect(r.people).toEqual(expect.arrayContaining([{ id: HEAD, name: "Harun Head" }, { id: "99999999-9999-4999-8999-999999999999", name: null }]));
    expect(r.types.map((t) => t.key)).toEqual(["closure", "withdrawal", "phone_change"]);
    expect(r.rejections).toEqual([{ category: "duplicate", count: 1 }]);
  });

  it("says when the range held more than it reads", async () => {
    for (let i = 0; i < REPORT_CAP + 3; i++) db.seed("compliance_requests", [{ id: `bulk-${i}`, account_id: ACCOUNT, reference: `B${i}`, type_key: "closure", source: "form", status: "received", received_at: "2026-09-20T00:00:00.000Z", signoff: {} }]);
    const r = await loadReport(db.client(), head(), NONE, () => NOW);
    expect(r.truncated).toBe(true);
    expect(r.total).toBe(REPORT_CAP);
  });

  it("carries no name, phone number, email or bank detail", async () => {
    add({ data_enc: "ciphertext", data: { reason: "private words" } });
    const text = JSON.stringify(await loadReport(db.client(), head(), NONE, () => NOW));
    for (const bad of ["Siti", "example.test", "+6012", "ciphertext", "private words"]) expect(text).not.toContain(bad);
  });
});

describe("parseReportFilters", () => {
  it("takes instants and a type, and ignores anything else", () => {
    expect(parseReportFilters(new URLSearchParams("from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z&type=closure"))).toEqual({ from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z", type: "closure" });
    expect(parseReportFilters(new URLSearchParams("from=yesterday&to=&type=Closure;DROP"))).toEqual(NONE);
    expect(parseReportFilters(new URLSearchParams())).toEqual(NONE);
  });
});

describe("the export", () => {
  it("records who exported what BEFORE it hands the file over, and the file has no personal data", async () => {
    add({ status: "completed", completed_at: "2026-09-25T00:00:00.000Z", signoff: { decision: "approved", by: HEAD } });
    const range = { from: "2026-09-01T00:00:00.000Z", to: null, type: "closure" };
    const r = await exportReportCsv(db.client(), officer(), range);
    expect(r).toMatchObject({ rows: 1, truncated: false });
    expect(r.csv.split("\r\n")[0]).toContain("reference,type,source,status");
    const log = (db.rows("compliance_exports") as any[])[0];
    expect(log).toMatchObject({ account_id: ACCOUNT, actor: OFFICER, kind: "csv", row_count: 1, truncated: false, filters: range });
    for (const bad of ["Siti", "example.test", "+6012"]) expect(r.csv).not.toContain(bad);
    expect(JSON.stringify(log)).not.toContain("Siti");
  });

  it("returns nothing when the log cannot be written", async () => {
    add();
    db.failNext.compliance_exports = "boom";
    expect(await fails(exportReportCsv(db.client(), officer(), NONE))).toMatchObject({ code: "audit_failed" });
    expect(db.rows("compliance_exports")).toHaveLength(0);
  });

  it("is for the officer and the Head only", async () => {
    expect(await fails(exportReportCsv(db.client(), ops(), NONE))).toMatchObject({ code: "forbidden" });
    expect(db.rows("compliance_exports")).toHaveLength(0);
  });

  it("exports at most the cap and says it stopped", async () => {
    for (let i = 0; i < REPORT_CAP + 2; i++) db.seed("compliance_requests", [{ id: `bulk-${i}`, account_id: ACCOUNT, reference: `B${i}`, type_key: "closure", source: "form", status: "received", received_at: "2026-09-20T00:00:00.000Z", signoff: {} }]);
    const r = await exportReportCsv(db.client(), head(), NONE);
    expect(r).toMatchObject({ rows: REPORT_CAP, truncated: true });
    expect((db.rows("compliance_exports") as any[])[0]).toMatchObject({ row_count: REPORT_CAP, truncated: true });
  });

  it("labels the type with its name", async () => {
    add();
    expect((await exportReportCsv(db.client(), head(), NONE)).csv).toContain(",Account closure,");
  });
});

describe("the badge", () => {
  const officerOnly = () => callerFor(OFFICER, ["compliance.review"]);
  const headOnly = () => callerFor(HEAD, ["compliance.approve"]);

  beforeEach(() => {
    add({ status: "received" });
    add({ status: "identity_check" });
    add({ status: "officer_review" });
    add({ status: "awaiting_signoff", identity_check: { verified_by: OFFICER, recorded_by: OFFICER } });
    add({ status: "awaiting_signoff", identity_check: { verified_by: HEAD, recorded_by: HEAD } });
    add({ status: "approved" });
    add({ status: "completed" });
    add({ status: "received", account_id: OTHER_ACCOUNT });
  });

  it("counts for an officer the cases waiting for an identity check or a review", async () => {
    expect(await badgeCount(db.client(), officerOnly())).toBe(3);
  });

  it("counts for the Head the cases awaiting sign-off that they could sign, not one whose identity check they recorded", async () => {
    expect(await badgeCount(db.client(), headOnly())).toBe(1);
  });

  it("counts both for a person who holds both permissions", async () => {
    expect(await badgeCount(db.client(), callerFor(OFFICER, ["compliance.review", "compliance.approve"]))).toBe(3 + 1);
    expect(await badgeCount(db.client(), callerFor(HEAD, ["compliance.review", "compliance.approve"]))).toBe(3 + 1);
  });

  it("is zero for anyone who can neither sign off nor review", async () => {
    expect(await badgeCount(db.client(), callerFor(OPS, ["compliance.execute"]))).toBe(0);
    expect(await badgeCount(db.client(), callerFor(AGENT, ["compliance.raise"]))).toBe(0);
  });

  it("does not see another workspace's cases", async () => {
    expect(await badgeCount(db.client(), callerFor(OFFICER, ["compliance.review"], OTHER_ACCOUNT))).toBe(1);
  });
});
