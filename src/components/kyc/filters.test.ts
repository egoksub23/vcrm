// The filters over the list of checks, and the paging the screen does for the ones the back end will not apply. Pure functions: no React, no network.

import { describe, expect, it } from "vitest";

import type { KycValidation } from "@/lib/kyc/types";

import { AUTO_PAGE_MAX, AUTO_PAGE_TARGET, DEFAULT_FILTERS, NO_FILTERS, canFetch, dateRangeRequired, dateRangeValid, isDefaultFilters, filterValidations, matchesFilters, needsOwnPaging, resultOptions, reviewWord, shouldKeepPaging, type KycFilters } from "./helpers";

const v = (over: Partial<KycValidation> = {}): KycValidation => ({
  id: "1",
  idUsable: true,
  friendId: "child-77",
  type: "NRIC",
  status: { raw: "UNREADABLE", tone: "negative" },
  createdAt: null,
  createdAtRaw: null,
  updatedAt: null,
  score: null,
  reason: null,
  known: [],
  extra: [],
  withheld: 0,
  fallback: false,
  hasMasked: false,
  people: [],
  review: null,
  ...over,
});

const reviewed = (raw: string) => v({ review: { raw, tone: "positive", note: null, at: null } });
const f = (over: Partial<KycFilters> = {}): KycFilters => ({ ...NO_FILTERS, ...over });

describe("which checks the reviewer is shown", () => {
  it("reads the back end's decision word, whatever case or tense it is in", () => {
    expect(reviewWord(v())).toBeNull();
    expect(reviewWord(reviewed("APPROVED"))).toBe("approved");
    expect(reviewWord(reviewed("approve"))).toBe("approved");
    expect(reviewWord(reviewed("REJECTED"))).toBe("rejected");
    expect(reviewWord(reviewed(" reject "))).toBe("rejected");
    expect(reviewWord(reviewed("ESCALATED"))).toBe("other");
  });

  it("filters by result word and document kind; review_status is server-side and not re-checked client-side", () => {
    const pending = v();
    const ok = reviewed("APPROVED");
    // review_status filter is server-side: matchesFilters does not re-filter on it
    expect(matchesFilters(pending, NO_FILTERS)).toBe(true);
    expect(matchesFilters(ok, NO_FILTERS)).toBe(true);
    expect(matchesFilters(pending, f({ reviewStatus: "pending" }))).toBe(true);
    expect(matchesFilters(ok, f({ reviewStatus: "pending" }))).toBe(true);
    // the result word as the back end sends it, whatever case it arrives in
    expect(matchesFilters(pending, f({ result: "unreadable" }))).toBe(true);
    expect(matchesFilters(pending, f({ result: "MATCH" }))).toBe(false);
    expect(matchesFilters(v({ status: { raw: null, tone: "neutral" } }), f({ result: "MATCH" }))).toBe(false);
  });

  it("applies the document kind itself, so the filter holds even if the back end ignored the one it was sent", () => {
    expect(matchesFilters(v({ type: "NRIC" }), f({ docType: "nric" }))).toBe(true);
    expect(matchesFilters(v({ type: "PASSPORT" }), f({ docType: "nric" }))).toBe(false);
    expect(matchesFilters(v({ type: null }), f({ docType: "nric" }))).toBe(false);
  });

  it("keeps the back end's order and offers the status words actually seen, once each", () => {
    const items = [v({ id: "1" }), v({ id: "2", review: { raw: "APPROVED", tone: "positive", note: null, at: null } }), v({ id: "3", status: { raw: "MATCH", tone: "positive" } })];
    // review_status is server-side — both id 1 and 2 have UNREADABLE status and pass the result filter
    expect(filterValidations(items, f({ result: "UNREADABLE" })).map((x) => x.id)).toEqual(["1", "2"]);
    expect(resultOptions(items)).toEqual(["MATCH", "UNREADABLE"]);
    expect(resultOptions([v({ status: { raw: null, tone: "neutral" } })])).toEqual([]);
  });
});

describe("reading further pages for a filter the back end will not apply", () => {
  it("is only needed for the result word; review_status and doc_type are both server-side", () => {
    expect(needsOwnPaging(NO_FILTERS)).toBe(false);
    expect(needsOwnPaging(f({ docType: "passport" }))).toBe(false);
    expect(needsOwnPaging(f({ reviewStatus: "approved" }))).toBe(false);
    expect(needsOwnPaging(f({ result: "MATCH" }))).toBe(true);
  });

  it("stops at enough matches, at the end of the list, or at the cap — and never reads a second page unfiltered", () => {
    const base = { matches: 0, pages: 1, hasMore: true, filters: f({ result: "MATCH" }) };
    expect(shouldKeepPaging(base)).toBe(true);
    expect(shouldKeepPaging({ ...base, hasMore: false })).toBe(false);
    expect(shouldKeepPaging({ ...base, matches: AUTO_PAGE_TARGET })).toBe(false);
    expect(shouldKeepPaging({ ...base, pages: AUTO_PAGE_MAX })).toBe(false);
    // an unfiltered list is paged by the reviewer pressing "Load older", never on its own
    expect(shouldKeepPaging({ ...base, filters: NO_FILTERS })).toBe(false);
    expect(shouldKeepPaging({ ...base, filters: f({ docType: "nric" }) })).toBe(false);
  });

  it("reads at most the cap in one go, however empty the pages are", () => {
    let pages = 0;
    while (shouldKeepPaging({ matches: 0, pages, hasMore: true, filters: f({ result: "MATCH" }) })) pages += 1;
    expect(pages).toBe(AUTO_PAGE_MAX);
  });
});

describe("what the page opens on", () => {
  it("is Needs review (pending), with no date range needed", () => {
    expect(DEFAULT_FILTERS).toEqual({ reviewStatus: "pending", dateFrom: "", dateTo: "", result: "", docType: "" });
    expect(isDefaultFilters(DEFAULT_FILTERS)).toBe(true);
    expect(isDefaultFilters(NO_FILTERS)).toBe(false);
    expect(isDefaultFilters(f({ reviewStatus: "approved" }))).toBe(false);
    expect(isDefaultFilters(f({ reviewStatus: "pending", docType: "nric" }))).toBe(false);
    expect(isDefaultFilters(f({ reviewStatus: "pending", result: "UNREADABLE" }))).toBe(false);
  });

  it("pending does not need own paging since the back end now applies it server-side", () => {
    expect(needsOwnPaging(DEFAULT_FILTERS)).toBe(false);
  });
});

describe("date range gate", () => {
  it("pending needs no dates; every other status does", () => {
    expect(dateRangeRequired(f({ reviewStatus: "pending" }))).toBe(false);
    expect(dateRangeRequired(f({ reviewStatus: "approved" }))).toBe(true);
    expect(dateRangeRequired(f({ reviewStatus: "rejected" }))).toBe(true);
    expect(dateRangeRequired(f({ reviewStatus: "staff_rejected" }))).toBe(true);
    expect(dateRangeRequired(f({ reviewStatus: "auto_rejected" }))).toBe(true);
    expect(dateRangeRequired(f({ reviewStatus: "all" }))).toBe(true);
  });

  it("dates are valid when both are YYYY-MM-DD and from <= to", () => {
    expect(dateRangeValid(f({ dateFrom: "2026-10-01", dateTo: "2026-10-28" }))).toBe(true);
    expect(dateRangeValid(f({ dateFrom: "2026-10-28", dateTo: "2026-10-28" }))).toBe(true);
    expect(dateRangeValid(f({ dateFrom: "2026-10-29", dateTo: "2026-10-28" }))).toBe(false);
    expect(dateRangeValid(f({ dateFrom: "", dateTo: "2026-10-28" }))).toBe(false);
    expect(dateRangeValid(f({ dateFrom: "2026-10-01", dateTo: "" }))).toBe(false);
  });

  it("canFetch is true when dates are not required, or when they are valid", () => {
    expect(canFetch(f({ reviewStatus: "pending" }))).toBe(true);
    expect(canFetch(f({ reviewStatus: "approved", dateFrom: "", dateTo: "" }))).toBe(false);
    expect(canFetch(f({ reviewStatus: "approved", dateFrom: "2026-10-01", dateTo: "2026-10-28" }))).toBe(true);
  });
});
