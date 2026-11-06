import { describe, expect, it } from "vitest";

import { describeNotBefore, isActive, parseClearance } from "./clearance";

const NOW = new Date("2026-11-11T10:00:00Z");
const ok = { incident_id: "i1", student_id: "S-1", type: "concussion", not_before: "2026-11-20", note: " Rest. " };

describe("parseClearance", () => {
  it("accepts a date for a student on an incident", () => {
    expect(parseClearance(ok, NOW)).toEqual({ ok: true, value: { incidentId: "i1", studentId: "S-1", type: "concussion", notBefore: "2026-11-20", note: "Rest." } });
  });
  it("defaults the type to injury and the note to nothing", () => {
    expect(parseClearance({ ...ok, type: undefined, note: "" }, NOW)).toMatchObject({ ok: true, value: { type: "injury", note: null } });
  });
  it("refuses a date in the past, one more than a year away, or one that is not a date", () => {
    expect(parseClearance({ ...ok, not_before: "2026-11-10" }, NOW)).toMatchObject({ ok: false, error: "That date has already passed." });
    expect(parseClearance({ ...ok, not_before: "2028-01-01" }, NOW)).toMatchObject({ ok: false });
    expect(parseClearance({ ...ok, not_before: "20 Nov" }, NOW)).toMatchObject({ ok: false });
    expect(parseClearance({ ...ok, not_before: "2026-11-11" }, NOW)).toMatchObject({ ok: true });
  });
  it("needs the incident, the student and a known type", () => {
    expect(parseClearance({ ...ok, incident_id: "" }, NOW)).toMatchObject({ ok: false });
    expect(parseClearance({ ...ok, student_id: undefined }, NOW)).toMatchObject({ ok: false });
    expect(parseClearance({ ...ok, type: "sprain" }, NOW)).toMatchObject({ ok: false });
    expect(parseClearance(null, NOW)).toMatchObject({ ok: false });
  });
});

describe("isActive", () => {
  it("warns until the day before the date, never after it is cleared", () => {
    expect(isActive({ not_before: "2026-11-20", cleared_at: null }, "2026-11-19")).toBe(true);
    expect(isActive({ not_before: "2026-11-20", cleared_at: null }, "2026-11-20")).toBe(false);
    expect(isActive({ not_before: "2026-11-20", cleared_at: "2026-11-12T00:00:00Z" }, "2026-11-12")).toBe(false);
  });
  it("writes the date for people", () => {
    expect(describeNotBefore("2026-11-20")).toBe("not before 20 Nov 2026");
  });
});
