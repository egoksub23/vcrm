import { describe, expect, it } from "vitest";

import { createdRange } from "../export/documents";
import { EMPTY_FILTERS, filtersKey, isFiltered, rangeIsBackwards, validDay } from "./list-filters";

// The date range and contact filters of the documents list: what counts as a filter, when the list must start again,
// and the instants the days become in the workspace's time zone (the same ones the CSV export uses).

describe("validDay", () => {
  it("keeps a real calendar day and drops everything else", () => {
    expect(validDay("2026-10-07")).toBe("2026-10-07");
    expect(validDay("2026-02-30")).toBe("");
    expect(validDay("2026-1-7")).toBe("");
    expect(validDay("")).toBe("");
    expect(validDay(undefined)).toBe("");
    expect(validDay(null)).toBe("");
  });
});

describe("the list's filters with a date range and a contact", () => {
  it("count as filters once a real day or a contact is set", () => {
    expect(isFiltered(EMPTY_FILTERS)).toBe(false);
    expect(isFiltered({ ...EMPTY_FILTERS, from: "2026-10-01" })).toBe(true);
    expect(isFiltered({ ...EMPTY_FILTERS, to: "2026-10-31" })).toBe(true);
    expect(isFiltered({ ...EMPTY_FILTERS, contactId: "c1" })).toBe(true);
    expect(isFiltered({ ...EMPTY_FILTERS, from: "", to: "", contactId: null })).toBe(false);
    // a half-typed date is not a filter yet
    expect(isFiltered({ ...EMPTY_FILTERS, from: "2026-1" })).toBe(false);
  });

  it("make a different list key, so the list and the ticked documents start again", () => {
    const base = filtersKey(EMPTY_FILTERS);
    expect(filtersKey({ ...EMPTY_FILTERS, from: "2026-10-01" })).not.toBe(base);
    expect(filtersKey({ ...EMPTY_FILTERS, to: "2026-10-31" })).not.toBe(base);
    expect(filtersKey({ ...EMPTY_FILTERS, contactId: "c1" })).not.toBe(base);
    expect(filtersKey({ ...EMPTY_FILTERS, from: "2026-10-01" })).not.toBe(filtersKey({ ...EMPTY_FILTERS, to: "2026-10-01" }));
    // nothing set, empty strings and a half-typed date are all the same list
    expect(filtersKey({ ...EMPTY_FILTERS, from: "", to: "", contactId: null })).toBe(base);
    expect(filtersKey({ ...EMPTY_FILTERS, from: "2026-1" })).toBe(base);
  });

  it("notice a range that runs backwards", () => {
    expect(rangeIsBackwards({ from: "2026-10-31", to: "2026-10-01" })).toBe(true);
    expect(rangeIsBackwards({ from: "2026-10-01", to: "2026-10-01" })).toBe(false);
    expect(rangeIsBackwards({ from: "2026-10-01", to: "" })).toBe(false);
    expect(rangeIsBackwards({})).toBe(false);
  });
});

describe("the days as the database is asked", () => {
  it("is the start of the first day up to the start of the day after the last, in the workspace's zone", () => {
    // Kuala Lumpur is UTC+8: 1 October starts at 16:00 UTC on 30 September
    expect(createdRange({ from: "2026-10-01", to: "2026-10-31" }, "Asia/Kuala_Lumpur")).toEqual({ gte: "2026-09-30T16:00:00.000Z", lt: "2026-10-31T16:00:00.000Z" });
    expect(createdRange({ from: "2026-10-01", to: null }, "UTC")).toEqual({ gte: "2026-10-01T00:00:00.000Z", lt: null });
    expect(createdRange({ from: null, to: "2026-10-07" }, "UTC")).toEqual({ gte: null, lt: "2026-10-08T00:00:00.000Z" });
  });

  it("falls back to UTC for a zone the browser does not know", () => {
    expect(createdRange({ from: "2026-10-01", to: null }, "Not/AZone").gte).toBe("2026-10-01T00:00:00.000Z");
  });
});
