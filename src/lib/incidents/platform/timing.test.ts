import { describe, expect, it } from "vitest";

import { ACK_RECIPE_KEY, DEFAULT_ACK_WAIT_MINUTES, effectiveHours, LEGAL_PACK_SLUGS, modeOf, parseAckWait, parseStepSetting, toOverrideRow } from "./timing";
import { RECIPES } from "./rules";

describe("the acknowledgement wait", () => {
  it("ships at 30 minutes, and the starter recipe uses the school's setting when it has one", () => {
    expect(DEFAULT_ACK_WAIT_MINUTES).toBe(30);
    const recipe = RECIPES.find((r) => r.key === ACK_RECIPE_KEY)!;
    expect(recipe.build({ serious: "high" }).wait_minutes).toBe(30);
    expect(recipe.build({ serious: "high", ackWait: 90 }).wait_minutes).toBe(90);
  });
  it("accepts whole minutes between 1 and 30 days, as a number or typed text", () => {
    expect(parseAckWait(45)).toEqual({ ok: true, value: 45 });
    expect(parseAckWait("15")).toEqual({ ok: true, value: 15 });
    expect(parseAckWait(43200)).toEqual({ ok: true, value: 43200 });
  });
  it("refuses anything else", () => {
    for (const bad of [0, -5, 1.5, 43201, "", "soon", null, undefined, NaN]) expect(parseAckWait(bad), String(bad)).toMatchObject({ ok: false });
  });
});

describe("a built-in step's deadline", () => {
  const base = { rule_id: "r1" };
  it("takes the shipped values, the school's own hours, or no deadline", () => {
    expect(parseStepSetting({ ...base, mode: "default" })).toEqual({ ok: true, value: { ruleId: "r1", mode: "default", dueHours: null, enabled: true } });
    expect(parseStepSetting({ ...base, mode: "hours", hours: 48 })).toEqual({ ok: true, value: { ruleId: "r1", mode: "hours", dueHours: 48, enabled: true } });
    expect(parseStepSetting({ ...base, mode: "hours", hours: "6", enabled: false })).toEqual({ ok: true, value: { ruleId: "r1", mode: "hours", dueHours: 6, enabled: false } });
    expect(parseStepSetting({ ...base, mode: "none" })).toMatchObject({ ok: true, value: { mode: "none", dueHours: null } });
  });
  it("ignores hours unless the mode is hours", () => {
    expect(parseStepSetting({ ...base, mode: "none", hours: 5 })).toMatchObject({ ok: true, value: { dueHours: null } });
  });
  it("refuses a missing step, an unknown mode, and hours that are not a whole number from 1 to 8760", () => {
    expect(parseStepSetting(null)).toMatchObject({ ok: false });
    expect(parseStepSetting({ mode: "default" })).toMatchObject({ ok: false });
    expect(parseStepSetting({ ...base, mode: "sometime" })).toMatchObject({ ok: false });
    expect(parseStepSetting({ ...base, mode: "default", enabled: "yes" })).toMatchObject({ ok: false });
    for (const bad of [0, -1, 2.5, 8761, "", "soon", undefined]) expect(parseStepSetting({ ...base, mode: "hours", hours: bad }), String(bad)).toMatchObject({ ok: false });
  });
  it("stores nothing when the choice is just the shipped values, and a row otherwise", () => {
    expect(toOverrideRow({ ruleId: "r", mode: "default", dueHours: null, enabled: true })).toBeNull();
    expect(toOverrideRow({ ruleId: "r", mode: "hours", dueHours: 12, enabled: true })).toEqual({ due_hours: 12, no_deadline: false, enabled: true });
    expect(toOverrideRow({ ruleId: "r", mode: "none", dueHours: null, enabled: true })).toEqual({ due_hours: null, no_deadline: true, enabled: true });
    expect(toOverrideRow({ ruleId: "r", mode: "default", dueHours: null, enabled: false })).toEqual({ due_hours: null, no_deadline: false, enabled: false });
  });
  it("works out the hours a new incident will get, and the mode to show", () => {
    expect(effectiveHours(72, null)).toBe(72);
    expect(effectiveHours(72, { due_hours: 24, no_deadline: false, enabled: true })).toBe(24);
    expect(effectiveHours(72, { due_hours: null, no_deadline: true, enabled: true })).toBeNull();
    expect(effectiveHours(72, { due_hours: null, no_deadline: false, enabled: false })).toBe(72);
    expect(effectiveHours(null, { due_hours: 8, no_deadline: false, enabled: true })).toBe(8);
    expect(modeOf(null)).toBe("default");
    expect(modeOf({ due_hours: 5, no_deadline: false, enabled: true })).toBe("hours");
    expect(modeOf({ due_hours: null, no_deadline: true, enabled: true })).toBe("none");
    expect(modeOf({ due_hours: null, no_deadline: false, enabled: false })).toBe("default");
  });
  it("marks the PDPA pack as the one whose deadlines come from law", () => {
    expect(LEGAL_PACK_SLUGS).toContain("pdpa_my");
    expect(LEGAL_PACK_SLUGS).not.toContain("school_policy");
  });
});
