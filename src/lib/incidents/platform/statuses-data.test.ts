import { describe, expect, it } from "vitest";

import type { PgDb } from "@/lib/postgres/db";
import { changeStatuses } from "./statuses-data";

/** A tiny in-memory stand-in for the database wrapper: rows per table, filters by eq, writes applied to the rows. */
function fakeDb(tables: Record<string, Record<string, unknown>[]>): PgDb {
  const from = (table: string) => {
    const filters: [string, unknown][] = [];
    let op: "select" | "update" | "delete" = "select";
    let patch: Record<string, unknown> = {};
    const matches = () => (tables[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (k: string, v: unknown) => (filters.push([k, v]), q),
      limit: () => q,
      insert: async (row: Record<string, unknown>) => ((tables[table] ??= []).push({ ...row }), { error: null }),
      update: (p: Record<string, unknown>) => ((op = "update"), (patch = p), q),
      delete: () => ((op = "delete"), q),
    };
    (q as { then: (f: (v: unknown) => unknown) => unknown }).then = (f) => {
      const rows = matches();
      if (op === "update") rows.forEach((r) => Object.assign(r, patch));
      if (op === "delete") tables[table] = (tables[table] ?? []).filter((r) => !rows.includes(r));
      return f({ data: op === "select" ? rows : null, error: null });
    };
    return q;
  };
  return { from } as unknown as PgDb;
}

const extra = { account_id: "a1", key: "s_waiting", label: "Waiting for parents", base_status: "investigating", position: 0, is_builtin: false, is_active: true };

describe("changeStatuses", () => {
  it("adds an extra status that counts as one of the six, with a key made from its name", async () => {
    const tables = { incident_status_options: [] as Record<string, unknown>[], incidents: [] };
    const r = await changeStatuses(fakeDb(tables), "a1", { action: "add", label: " Waiting for parents ", base: "investigating" });
    expect(r).toEqual({ ok: true });
    expect(tables.incident_status_options[0]).toMatchObject({ key: "s_waiting_for_parents", label: "Waiting for parents", base_status: "investigating", is_builtin: false });
  });

  it("refuses a name already used, a missing base, and too many", async () => {
    const tables = { incident_status_options: [{ ...extra }], incidents: [] };
    expect(await changeStatuses(fakeDb(tables), "a1", { action: "add", label: "waiting for parents", base: "investigating" })).toMatchObject({ ok: false, status: 409 });
    expect(await changeStatuses(fakeDb(tables), "a1", { action: "add", label: "Another", base: "somewhere" })).toMatchObject({ ok: false, status: 400 });
    const many = Array.from({ length: 12 }, (_, n) => ({ ...extra, key: `s_${n}`, label: `S${n}` }));
    expect(await changeStatuses(fakeDb({ incident_status_options: many, incidents: [] }), "a1", { action: "add", label: "One more", base: "recovered" })).toMatchObject({ ok: false, status: 409 });
  });

  it("renames a built-in status by recording the school's wording, and cannot hide or delete it", async () => {
    const tables = { incident_status_options: [] as Record<string, unknown>[], incidents: [] };
    expect(await changeStatuses(fakeDb(tables), "a1", { action: "rename", key: "triaged", label: "Assessed" })).toEqual({ ok: true });
    expect(tables.incident_status_options[0]).toMatchObject({ key: "triaged", label: "Assessed", is_builtin: true });
    expect(await changeStatuses(fakeDb(tables), "a1", { action: "hide", key: "triaged", active: false })).toMatchObject({ ok: false, status: 400 });
    expect(await changeStatuses(fakeDb(tables), "a1", { action: "delete", key: "triaged" })).toMatchObject({ ok: false, status: 400 });
  });

  it("hides an extra status, and deletes it only when no incident is in it", async () => {
    const tables = { incident_status_options: [{ ...extra }], incidents: [{ account_id: "a1", id: "i1", status_key: "s_waiting" }] };
    expect(await changeStatuses(fakeDb(tables), "a1", { action: "hide", key: "s_waiting", active: false })).toEqual({ ok: true });
    expect(tables.incident_status_options[0].is_active).toBe(false);
    expect(await changeStatuses(fakeDb(tables), "a1", { action: "delete", key: "s_waiting" })).toMatchObject({ ok: false, status: 409 });
    tables.incidents = [];
    expect(await changeStatuses(fakeDb(tables), "a1", { action: "delete", key: "s_waiting" })).toEqual({ ok: true });
    expect(tables.incident_status_options).toHaveLength(0);
  });

  it("says so for a status that does not exist", async () => {
    expect(await changeStatuses(fakeDb({ incident_status_options: [], incidents: [] }), "a1", { action: "rename", key: "nope", label: "X" })).toMatchObject({ ok: false, status: 404 });
  });
});
