// The filters over the list of checks, and the paging the screen does for the ones the back end will not apply. Pure functions: no React, no network.

import { describe, expect, it } from "vitest";

import type { KycValidation } from "@/lib/kyc/types";

import { AUTO_PAGE_MAX, AUTO_PAGE_TARGET, NO_FILTERS, filterValidations, matchesFilters, needsOwnPaging, resultOptions, reviewWord, shouldKeepPaging, type KycFilters } from "./helpers";

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
    // a word nobody has seen yet is still a decision: it must never be listed as "needs review"
    expect(reviewWord(reviewed("ESCALATED"))).toBe("other");
    expect(matchesFilters(reviewed("ESCALATED"), f({ review: "pending" }))).toBe(false);
  });

  it("filters by the decision, the result word and the document kind, and lets everything through by default", () => {
    const pending = v();
    const ok = reviewed("APPROVED");
    expect(matchesFilters(pending, NO_FILTERS)).toBe(true);
    expect(matchesFilters(ok, NO_FILTERS)).toBe(true);
    expect(matchesFilters(pending, f({ review: "pending" }))).toBe(true);
    expect(matchesFilters(ok, f({ review: "pending" }))).toBe(false);
    expect(matchesFilters(ok, f({ review: "approved" }))).toBe(true);
    expect(matchesFilters(ok, f({ review: "rejected" }))).toBe(false);
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
    const items = [v({ id: "1" }), reviewed("APPROVED"), v({ id: "3", status: { raw: "MATCH", tone: "positive" } })];
    expect(filterValidations(items, f({ review: "pending" })).map((x) => x.id)).toEqual(["1", "3"]);
    expect(resultOptions(items)).toEqual(["MATCH", "UNREADABLE"]);
    expect(resultOptions([v({ status: { raw: null, tone: "neutral" } })])).toEqual([]);
  });
});

describe("reading further pages for a filter the back end will not apply", () => {
  it("is only needed for the decision and the result: the document kind is the back end's own filter", () => {
    expect(needsOwnPaging(NO_FILTERS)).toBe(false);
    expect(needsOwnPaging(f({ docType: "passport" }))).toBe(false);
    expect(needsOwnPaging(f({ review: "approved" }))).toBe(true);
    expect(needsOwnPaging(f({ result: "MATCH" }))).toBe(true);
  });

  it("stops at enough matches, at the end of the list, or at the cap — and never reads a second page unfiltered", () => {
    const base = { matches: 0, pages: 1, hasMore: true, filters: f({ review: "approved" }) };
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
    while (shouldKeepPaging({ matches: 0, pages, hasMore: true, filters: f({ review: "approved" }) })) pages += 1;
    expect(pages).toBe(AUTO_PAGE_MAX);
  });
});
