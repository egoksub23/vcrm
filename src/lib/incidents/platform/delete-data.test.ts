import { describe, expect, it, vi } from "vitest";

import type { PgDb } from "@/lib/postgres/db";

const removed: string[][] = [];
vi.mock("@/lib/storage/provider", () => ({ appStorage: () => ({ from: () => ({ remove: async (p: string[]) => { removed.push(p); return { data: null, error: null }; } }) }) }));

import { deleteIncidentForGood } from "./delete-data";

/** A tiny stand-in for the database wrapper: tables are arrays, filters by eq, and every write is recorded. */
function fakeDb(tables: Record<string, Record<string, unknown>[]>, log: { table: string; op: string; row?: unknown }[]): PgDb {
  const from = (table: string) => {
    let rows = tables[table] ?? [];
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (k: string, v: unknown) => {
        rows = rows.filter((r) => r[k] === v);
        return q;
      },
      maybeSingle: async () => ({ data: rows[0] ?? null }),
      insert: async (row: unknown) => {
        log.push({ table, op: "insert", row });
        return { error: null };
      },
      delete: () => {
        const d: Record<string, unknown> = { eq: () => d };
        (d as { then: (f: (v: unknown) => unknown) => unknown }).then = (f) => {
          log.push({ table, op: "delete" });
          return f({ error: null });
        };
        return d;
      },
    };
    (q as { then: (f: (v: unknown) => unknown) => unknown }).then = (f) => f({ data: rows, error: null });
    return q;
  };
  return { from } as unknown as PgDb;
}

const base = { id: "i1", account_id: "a1", incident_number: 9, created_at: "2026-11-09T01:00:00.000Z", title: "Duplicate", void_reason: "raised twice" };

describe("deleteIncidentForGood", () => {
  it("refuses an incident that is not voided", async () => {
    const log: { table: string; op: string }[] = [];
    const db = fakeDb({ incidents: [{ ...base, voided_at: null }] }, log);
    const r = await deleteIncidentForGood({ db, accountId: "a1", incidentId: "i1", userId: "u1", confirm: "INC-2026-9" });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(log).toEqual([]);
  });

  it("refuses when the reference was not typed correctly", async () => {
    const log: { table: string; op: string }[] = [];
    const db = fakeDb({ incidents: [{ ...base, voided_at: "2026-11-09T02:00:00.000Z" }] }, log);
    const r = await deleteIncidentForGood({ db, accountId: "a1", incidentId: "i1", userId: "u1", confirm: "INC-2026-8" });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(log).toEqual([]);
  });

  it("is a 404 for another school's incident", async () => {
    const db = fakeDb({ incidents: [{ ...base, account_id: "a2", voided_at: "2026-11-09T02:00:00.000Z" }] }, []);
    expect(await deleteIncidentForGood({ db, accountId: "a1", incidentId: "i1", userId: "u1", confirm: "INC-2026-9" })).toMatchObject({ ok: false, status: 404 });
  });

  it("logs the deletion (no personal details), deletes the incident and removes its files", async () => {
    removed.length = 0;
    const log: { table: string; op: string; row?: Record<string, unknown> }[] = [];
    const db = fakeDb(
      {
        incidents: [{ ...base, voided_at: "2026-11-09T02:00:00.000Z" }],
        incident_attachments: [{ incident_id: "i1", storage_path: "account-a1/incidents/a.jpg" }],
        incident_filed_reports: [{ incident_id: "i1", storage_path: "account-a1/incidents/reports/r.pdf" }],
      },
      log,
    );
    const r = await deleteIncidentForGood({ db, accountId: "a1", incidentId: "i1", userId: "u1", confirm: " INC-2026-9 " });
    expect(r).toEqual({ ok: true, reference: "INC-2026-9", filesRemoved: 2 });
    expect(log[0]).toMatchObject({ table: "incident_deletions", op: "insert", row: { reference: "INC-2026-9", title: "Duplicate", deleted_by: "u1", files_removed: 2 } });
    expect(log.some((l) => l.table === "incidents" && l.op === "delete")).toBe(true);
    expect(removed).toEqual([["account-a1/incidents/a.jpg", "account-a1/incidents/reports/r.pdf"]]);
  });
});
