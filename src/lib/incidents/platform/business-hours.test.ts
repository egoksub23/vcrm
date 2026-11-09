import { describe, expect, it } from "vitest";

import { sweepTimers } from "./engine";
import { ruleFromRecipe, seeded } from "./testing";

describe("timed rules and business hours", () => {
  it("asks for waits to be counted in elapsed time when the school has no schedule", async () => {
    const s = seeded();
    s.rules = [ruleFromRecipe("remind_unacknowledged", "r9"), ruleFromRecipe("step_overdue", "r10"), ruleFromRecipe("resolve_by", "r11")];
    await sweepTimers(s, ["a1"]);
    expect(s.hoursAsked.map((h) => h.kind).sort()).toEqual(["step_overdue", "unacknowledged", "unresolved"]);
    expect(s.hoursAsked.every((h) => h.hours === undefined)).toBe(true);
  });

  it("hands the schedule and each rule's own wait to the three sweeps when the school counts waits in business hours", async () => {
    const s = seeded();
    s.schedule = "sched-1";
    s.rules = [ruleFromRecipe("remind_unacknowledged", "r9", { wait_minutes: 30 }), ruleFromRecipe("step_overdue", "r10"), ruleFromRecipe("resolve_by", "r11")];
    await sweepTimers(s, ["a1"]);
    const asked = Object.fromEntries(s.hoursAsked.map((h) => [h.kind, h.hours]));
    expect(asked.unacknowledged).toEqual({ scheduleId: "sched-1", waitMinutes: 30 });
    expect(asked.step_overdue).toEqual({ scheduleId: "sched-1", waitMinutes: 60 });
    expect(asked.unresolved).toEqual({ scheduleId: "sched-1", waitMinutes: 14 * 1440 });
  });
});
