import { describe, expect, it } from "vitest";

import { DOCUMENT_STATUSES } from "../types";
import { EMPTY_FILTERS, GROUP_STATUSES, PAGE_SIZE, STATUS_GROUPS, filtersKey, isExpiringSoon, isFiltered, pageRange, sanitizeSearch, searchClause, signerSearchClause } from "./list-filters";

describe("status groups", () => {
  it("put every status in exactly one group (all is every status)", () => {
    for (const s of DOCUMENT_STATUSES) {
      const groups = STATUS_GROUPS.filter((g) => GROUP_STATUSES[g]?.includes(s));
      expect(groups, s).toHaveLength(1);
    }
    expect(GROUP_STATUSES.all).toBeNull();
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
