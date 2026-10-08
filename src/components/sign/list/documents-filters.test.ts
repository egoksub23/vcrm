import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ accountId: "a1", account: { timezone: "Asia/Kuala_Lumpur" } }) }));

import { EMPTY_FILTERS } from "@/lib/sign/client/list-filters";
import { narrow, narrowShared, rangeOf } from "@/hooks/use-sign-documents";

// A query that records what it was asked, standing in for the database's filter builder.
function recorder() {
  const calls: unknown[][] = [];
  const q: Record<string, unknown> = {};
  for (const m of ["in", "is", "not", "eq", "or", "gte", "lt"]) {
    q[m] = (...args: unknown[]) => {
      calls.push([m, ...args]);
      return q;
    };
  }
  return { q, calls };
}

describe("the list's date range and contact, as the database is asked", () => {
  it("asks for the contact and the days (in the workspace's zone) for documents and envelopes alike", () => {
    const f = { ...EMPTY_FILTERS, from: "2026-10-01", to: "2026-10-31", contactId: "c1" };
    const { q, calls } = recorder();
    narrowShared(q, f, rangeOf(f, "Asia/Kuala_Lumpur"));
    expect(calls).toEqual([
      ["eq", "contact_id", "c1"],
      ["gte", "created_at", "2026-09-30T16:00:00.000Z"],
      ["lt", "created_at", "2026-10-31T16:00:00.000Z"],
    ]);
  });

  it("asks for nothing extra when nothing is set, or only half-typed", () => {
    const { q, calls } = recorder();
    narrowShared(q, { ...EMPTY_FILTERS, from: "2026-1", to: "", contactId: null }, rangeOf({ ...EMPTY_FILTERS, from: "2026-1", to: "" }, "UTC"));
    expect(calls).toEqual([]);
  });

  it("keeps the status, category and search filters beside them", () => {
    const f = { ...EMPTY_FILTERS, group: "completed" as const, category: "none", contactId: "c1", from: "2026-10-01" };
    const { q, calls } = recorder();
    narrow(q, "completed", f, "title.ilike.%x%", rangeOf(f, "UTC"));
    // (the status, the cancelled ones left out of "Completed", no category, the contact, the first day, the search)
    expect(calls.map((c) => c[0])).toEqual(["in", "is", "is", "eq", "gte", "or"]);
    expect(calls[1]).toEqual(["is", "cancelled_at", null]);
  });
});
