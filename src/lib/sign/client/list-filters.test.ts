import { describe, expect, it } from "vitest";

import { DOCUMENT_STATUSES } from "../types";
import { EMPTY_FILTERS, GROUP_CANCELLED, GROUP_STATUSES, PAGE_SIZE, STATUS_GROUPS, filtersKey, isExpiringSoon, isFiltered, narrowByGroup, pageRange, sanitizeSearch, searchClause, signerSearchClause } from "./list-filters";

describe("status groups", () => {
  it("put every status in exactly one group (all is every status)", () => {
    for (const s of DOCUMENT_STATUSES) {
      const groups = STATUS_GROUPS.filter((g) => GROUP_STATUSES[g]?.includes(s));
      // "completed" is the one status two groups share, and they never overlap: a completed document that was cancelled afterwards (migration 181) is in
      // "cancelled" and not in "completed"
      expect(groups, s).toHaveLength(s === "completed" ? 2 : 1);
    }
    expect(GROUP_STATUSES.all).toBeNull();
    expect(STATUS_GROUPS.filter((g) => GROUP_STATUSES[g]?.includes("completed"))).toEqual(["completed", "cancelled"]);
    expect([GROUP_CANCELLED.completed, GROUP_CANCELLED.cancelled, GROUP_CANCELLED.all]).toEqual(["no", "yes", null]);
  });
});

describe("narrowing a query to a group (migration 181)", () => {
  const record = () => {
    const calls: unknown[][] = [];
    const q: Record<string, unknown> = {};
    for (const m of ["in", "is", "not"]) q[m] = (...args: unknown[]) => (calls.push([m, ...args]), q);
    return { q, calls };
  };

  it("keeps the cancelled documents out of Completed, takes only them for Cancelled, and leaves every other group, and no group, alone", () => {
    const completed = record();
    narrowByGroup(completed.q, "completed");
    expect(completed.calls).toEqual([["in", "status", ["completed"]], ["is", "cancelled_at", null]]);
    const cancelled = record();
    narrowByGroup(cancelled.q, "cancelled");
    expect(cancelled.calls).toEqual([["in", "status", ["completed"]], ["not", "cancelled_at", "is", null]]);
    const all = record();
    narrowByGroup(all.q, "all");
    narrowByGroup(all.q, null);
    expect(all.calls).toEqual([]);
    for (const g of ["draft", "waiting", "stopped", "test"] as const) {
      const r = record();
      narrowByGroup(r.q, g);
      expect(r.calls.some((c) => c.includes("cancelled_at")), g).toBe(false);
    }
  });

  it("offers the Cancelled group and tells it apart in the key of the filters", () => {
    expect(STATUS_GROUPS).toContain("cancelled");
    expect(filtersKey({ ...EMPTY_FILTERS, group: "cancelled" })).not.toBe(filtersKey({ ...EMPTY_FILTERS, group: "completed" }));
    expect(isFiltered({ ...EMPTY_FILTERS, group: "cancelled" })).toBe(true);
  });
});

describe("search", () => {
  it("strips the characters that would break a filter list", () => {
    expect(sanitizeSearch(' a,b(c)"d*e%f\\g ')).toBe("a b c d e f g");
    expect(sanitizeSearch("   ")).toBe("");
    expect(sanitizeSearch("x".repeat(200))).toHaveLength(80);
  });

  it("searches title and reference, and the documents a signer matched", () => {
    expect(searchClause("Ali")).toBe("title.ilike.%Ali%,reference.ilike.%Ali%");
    const id = "11111111-2222-3333-4444-555555555555";
    expect(searchClause("Ali", [id])).toBe(`title.ilike.%Ali%,reference.ilike.%Ali%,id.in.(${id})`);
  });

  it("ignores ids that are not ids and an empty search", () => {
    expect(searchClause("Ali", ["x),title.eq.1"])).toBe("title.ilike.%Ali%,reference.ilike.%Ali%");
    expect(searchClause("  ")).toBeNull();
    expect(signerSearchClause("")).toBeNull();
    expect(signerSearchClause("Siti")).toBe("full_name.ilike.%Siti%,email.ilike.%Siti%");
  });
});

describe("filters", () => {
  it("know when they narrow the list", () => {
    expect(isFiltered(EMPTY_FILTERS)).toBe(false);
    expect(isFiltered({ ...EMPTY_FILTERS, group: "draft" })).toBe(true);
    expect(isFiltered({ ...EMPTY_FILTERS, category: "none" })).toBe(true);
    expect(isFiltered({ ...EMPTY_FILTERS, search: " x " })).toBe(true);
    expect(isFiltered({ ...EMPTY_FILTERS, search: "  " })).toBe(false);
  });

  it("make one key for the same filters", () => {
    expect(filtersKey({ ...EMPTY_FILTERS, search: " Ali " })).toBe(filtersKey({ ...EMPTY_FILTERS, search: "ali" }));
    expect(filtersKey({ ...EMPTY_FILTERS, group: "draft" })).not.toBe(filtersKey(EMPTY_FILTERS));
  });
});

describe("paging", () => {
  it("cuts inclusive ranges", () => {
    expect(pageRange(0)).toEqual({ from: 0, to: PAGE_SIZE - 1 });
    expect(pageRange(25)).toEqual({ from: 25, to: 49 });
    expect(pageRange(10, 5)).toEqual({ from: 10, to: 14 });
    expect(pageRange(-3, 0)).toEqual({ from: 0, to: 0 });
  });
});

describe("expiring soon", () => {
  const now = Date.parse("2026-10-06T00:00:00Z");
  const inDays = (d: number) => new Date(now + d * 86400000).toISOString();

  it("is true for an open document that stops within three days", () => {
    expect(isExpiringSoon("sent", inDays(2), now)).toBe(true);
    expect(isExpiringSoon("in_progress", inDays(3), now)).toBe(true);
  });

  it("is false for later, for the past, for a finished or draft document, and without a date", () => {
    expect(isExpiringSoon("sent", inDays(4), now)).toBe(false);
    expect(isExpiringSoon("sent", inDays(-1), now)).toBe(false);
    expect(isExpiringSoon("completed", inDays(1), now)).toBe(false);
    expect(isExpiringSoon("draft", inDays(1), now)).toBe(false);
    expect(isExpiringSoon("sent", null, now)).toBe(false);
  });
});
