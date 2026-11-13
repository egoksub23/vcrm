import { describe, expect, it } from "vitest";

import { MAX_PEOPLE, parseInjuryDetails } from "./injury-details";

const ok = (raw: unknown) => {
  const r = parseInjuryDetails(raw);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe("parseInjuryDetails", () => {
  it("is fine with nothing at all", () => {
    expect(ok(undefined)).toBeNull();
    expect(ok(null)).toBeNull();
  });

  it("keeps who was hurt, the activity and when, and the answers under the coach form's own keys", () => {
    const v = ok({ people: [{ name: " Arvin Raj ", class_name: "2E" }, { name: "" }], activity: "Football", venue: "Field 1", date: "2026-11-05", time: "16:30", bodyPart: "leg", headInjury: false });
    expect(v?.people).toEqual([{ name: "Arvin Raj", class_name: "2E" }]);
    expect(v?.activity).toEqual({ name: "Football", venue: "Field 1", date: "2026-11-05", time: "16:30" });
    expect(v?.customFields).toEqual({ body_part: "leg", head_injury: false });
    expect(v?.concussion).toBe(false);
  });

  it("marks a hit to the head as a possible concussion", () => {
    expect(ok({ headInjury: true })?.concussion).toBe(true);
  });

  it("leaves the activity out when none of its parts was given", () => {
    expect(ok({ people: [{ name: "A" }] })?.activity).toBeNull();
  });

  it("refuses a bad date, time, body part or shape, in plain words", () => {
    expect(parseInjuryDetails({ date: "5/11/2026" })).toEqual({ ok: false, error: "The date must look like 2026-11-05." });
    expect(parseInjuryDetails({ time: "25:00" })).toEqual({ ok: false, error: "The time must look like 14:30." });
    expect(parseInjuryDetails({ bodyPart: "elbow" }).ok).toBe(false);
    expect(parseInjuryDetails({ headInjury: "yes" }).ok).toBe(false);
    expect(parseInjuryDetails([]).ok).toBe(false);
    expect(parseInjuryDetails({ people: "Arvin" }).ok).toBe(false);
  });

  it("limits how many people can be named", () => {
    const people = Array.from({ length: MAX_PEOPLE + 1 }, (_, n) => ({ name: `Student ${n}` }));
    expect(parseInjuryDetails({ people }).ok).toBe(false);
  });

  it("cuts very long text", () => {
    expect(ok({ activity: "x".repeat(500) })?.activity?.name).toHaveLength(120);
  });
});
