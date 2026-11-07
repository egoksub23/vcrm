import { describe, expect, it } from "vitest";

import { dayOf, isoOf, textDates } from "./dates";
import { buildTrends, inRange, type RegisterIncident } from "./registers";
import { isActive } from "./clearance";

describe("dates read from the database", () => {
  it("become text, whether the driver gave a Date or text", () => {
    expect(isoOf(new Date("2026-11-07T08:30:00Z"))).toBe("2026-11-07T08:30:00.000Z");
    expect(isoOf("2026-11-07T08:30:00.000Z")).toBe("2026-11-07T08:30:00.000Z");
    expect(isoOf(null)).toBeNull();
    expect(isoOf(undefined)).toBeNull();
    expect(isoOf(new Date("nonsense"))).toBeNull();
    expect(dayOf(new Date("2026-11-20T00:00:00Z"))).toBe("2026-11-20");
    expect(dayOf("2026-11-20")).toBe("2026-11-20");
    expect(dayOf(null)).toBeNull();
  });
  it("convert only the named columns of a row", () => {
    const row = textDates({ id: "x", created_at: new Date("2026-10-01T01:00:00Z"), closed_at: null, not_before: new Date("2026-11-20T00:00:00Z") }, ["created_at", "closed_at"], ["not_before"]);
    expect(row).toEqual({ id: "x", created_at: "2026-10-01T01:00:00.000Z", closed_at: null, not_before: "2026-11-20" });
  });
  it("let the trends, the register range and the return-to-play check run on rows that came from the driver", () => {
    const raw = { id: "a", incident_number: 1, created_at: new Date("2026-10-15T08:00:00Z"), closed_at: null, title: "t", incident_type: "CCA", severity: "high", status: "reported", incident_flags: [], source: "halo", is_test: false, activity: null, involved_count: 0 };
    const row = textDates(raw, ["created_at", "closed_at"]) as unknown as RegisterIncident;
    expect(() => buildTrends([row], new Date("2026-11-07T00:00:00Z"))).not.toThrow();
    expect(inRange(row, { from: "2026-10-01", to: "2026-10-31" })).toBe(true);
    const c = textDates({ not_before: new Date("2026-11-20T00:00:00Z"), cleared_at: null }, ["cleared_at"], ["not_before"]);
    expect(isActive(c as unknown as { not_before: string; cleared_at: string | null }, "2026-11-07")).toBe(true);
  });
});
