import { describe, expect, it } from "vitest";

import { describeDue, nextStepCode, packSlug, parsePackRule } from "./pack";

const roles = ["principal", "head_of_sport"];
const ok = { title: " Phone the parents ", description: "Say what happened.", trigger_flag: "injury", due_hours: 4, role_key: "head_of_sport" };

describe("parsePackRule", () => {
  it("accepts a step with a role and a deadline", () => {
    expect(parsePackRule(ok, roles)).toEqual({ ok: true, value: { title: "Phone the parents", description: "Say what happened.", triggerFlag: "injury", dueHours: 4, roleKey: "head_of_sport" } });
  });
  it("lets the deadline and the role be left empty", () => {
    expect(parsePackRule({ title: "Write it up", trigger_flag: "property_damage", due_hours: "", role_key: "" }, roles)).toEqual({
      ok: true,
      value: { title: "Write it up", description: null, triggerFlag: "property_damage", dueHours: null, roleKey: null },
    });
  });
  it("explains each problem", () => {
    expect(parsePackRule({ ...ok, title: "ab" }, roles)).toMatchObject({ ok: false, error: expect.stringContaining("few words") });
    expect(parsePackRule({ ...ok, title: "x".repeat(161) }, roles)).toMatchObject({ ok: false });
    expect(parsePackRule({ ...ok, trigger_flag: "weather" }, roles)).toMatchObject({ ok: false, error: "Choose what the incident involves." });
    for (const bad of [0, -1, 2.5, 9000, "soon"]) expect(parsePackRule({ ...ok, due_hours: bad }, roles)).toMatchObject({ ok: false });
    expect(parsePackRule({ ...ok, role_key: "ghost" }, roles)).toMatchObject({ ok: false });
    expect(parsePackRule(null, roles)).toMatchObject({ ok: false });
  });
});

describe("pack helpers", () => {
  it("numbers steps without reusing a deleted number", () => {
    expect(nextStepCode([])).toBe("step_1");
    expect(nextStepCode(["step_1", "step_4", "pdpa_notify"])).toBe("step_5");
  });
  it("makes a pack slug that is the same for a school every time and different between schools", () => {
    const a = packSlug("11111111-2222-3333-4444-555555555555");
    expect(a).toBe(packSlug("11111111-2222-3333-4444-555555555555"));
    expect(a).not.toBe(packSlug("99999999-2222-3333-4444-555555555555"));
    expect(a).toMatch(/^school_pack_[0-9a-f]{12}$/);
  });
  it("words a deadline", () => {
    expect(describeDue(null)).toBe("no deadline");
    expect(describeDue(1)).toBe("within 1 hour");
    expect(describeDue(4)).toBe("within 4 hours");
    expect(describeDue(24)).toBe("within 1 day");
    expect(describeDue(72)).toBe("within 3 days");
  });
});
