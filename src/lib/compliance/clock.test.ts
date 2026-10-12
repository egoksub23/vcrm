import { describe, expect, it } from "vitest";

import { ALERT_THRESHOLDS, DAY_MS, alertLevelFor, computeClock, inDueBucket, type ClockInput } from "./clock";

const T0 = Date.parse("2026-10-01T09:00:00Z");
const at = (days: number, hours = 0) => new Date(T0 + days * DAY_MS + hours * 3_600_000).toISOString();
const closure = (over: Partial<ClockInput> = {}): ClockInput => ({
  status: "officer_review",
  receivedAt: at(0),
  targetDays: 14,
  hardStopDays: 30,
  targetDueAt: at(14),
  hardStopAt: at(30),
  pausedAt: null,
  ...over,
});
const now = (days: number, hours = 0) => T0 + days * DAY_MS + hours * 3_600_000;

describe("computeClock: a closure (14-day target, 30-day hard stop)", () => {
  it("is on track on the day it arrives: day 1, 14 to the target, 30 to the stop", () => {
    expect(computeClock(closure(), now(0, 1))).toMatchObject({ state: "on_track", level: "ok", dayNumber: 1, daysToTarget: 14, daysToStop: 30, alertLevel: 0 });
  });

  it("counts the request day as day 1 and says 'Day 9 of 14 target, 21 days to stop' eight days later", () => {
    const v = computeClock(closure(), now(8, 2));
    expect(v).toMatchObject({ state: "on_track", dayNumber: 9, targetDays: 14, daysToStop: 22 });
    // 21.x days left rounds up to 22; at exactly 8 days it is 22, at 9 days 21
    expect(computeClock(closure(), now(9)).daysToStop).toBe(21);
  });

  it("turns amber the moment the 14-day target passes and stays amber until 10 days before the stop", () => {
    expect(computeClock(closure(), now(14) - 1).state).toBe("on_track");
    expect(computeClock(closure(), now(14))).toMatchObject({ state: "target_passed", level: "amber", dayNumber: 15 });
    expect(computeClock(closure(), now(19, 23)).state).toBe("target_passed");
  });

  it("turns red ('near stop') at 10 days before the hard stop, with the 10-day alert level; 5 days is the second", () => {
    expect(computeClock(closure(), now(20))).toMatchObject({ state: "near_stop", level: "red", daysToStop: 10, alertLevel: 1 });
    expect(computeClock(closure(), now(25))).toMatchObject({ state: "near_stop", level: "red", daysToStop: 5, alertLevel: 2 });
    expect(computeClock(closure(), now(29, 23))).toMatchObject({ state: "near_stop", alertLevel: 2 });
  });

  it("is breached at the hard stop and counts the days over", () => {
    expect(computeClock(closure(), now(30))).toMatchObject({ state: "breached", level: "red", alertLevel: 3, daysToStop: 0, daysOverStop: 0 });
    expect(computeClock(closure(), now(33, 5))).toMatchObject({ state: "breached", daysToStop: -3, daysOverStop: 3 });
  });

  it("rounds days to the stop up: four hours left is one day", () => {
    expect(computeClock(closure(), now(30) - 4 * 3_600_000).daysToStop).toBe(1);
  });
});

describe("computeClock: other clocks", () => {
  it("has no clock for a type with neither target nor stop", () => {
    const v = computeClock(closure({ targetDays: null, hardStopDays: null, targetDueAt: null, hardStopAt: null }), now(100));
    expect(v).toMatchObject({ state: "none", level: "none", daysToTarget: null, daysToStop: null, alertLevel: 0 });
    expect(v.dayNumber).toBe(101);
  });

  it("handles a target without a stop (amber only) and a stop without a target (red only)", () => {
    expect(computeClock(closure({ hardStopDays: null, hardStopAt: null }), now(40)).state).toBe("target_passed");
    expect(computeClock(closure({ targetDays: null, targetDueAt: null }), now(5)).state).toBe("on_track");
    expect(computeClock(closure({ targetDays: null, targetDueAt: null }), now(22)).state).toBe("near_stop");
  });

  it("copes with an unreadable date by treating it as absent", () => {
    expect(computeClock(closure({ targetDueAt: "nonsense" }), now(40)).daysToTarget).toBeNull();
  });
});

describe("computeClock: pause", () => {
  it("freezes at the moment of the pause: nothing advances while paused", () => {
    const paused = closure({ pausedAt: at(12) });
    const early = computeClock(paused, now(12, 1));
    const late = computeClock(paused, now(60));
    expect(early).toMatchObject({ state: "paused", level: "grey", paused: true, dayNumber: 13, daysToStop: 18, daysToTarget: 2 });
    expect(late).toEqual(early);
  });

  it("is paused rather than breached, even when the dates have long passed in wall time", () => {
    expect(computeClock(closure({ pausedAt: at(10) }), now(90)).state).toBe("paused");
  });

  it("after a resume the stored dates are later (the database moved them), so the case is on track again", () => {
    // paused for 5 days at day 10: both dates moved 5 days later, pause cleared
    const resumed = closure({ pausedAt: null, targetDueAt: at(19), hardStopAt: at(35) });
    expect(computeClock(resumed, now(15))).toMatchObject({ state: "on_track", daysToStop: 20 });
  });
});

describe("computeClock: a finished case", () => {
  it("is done, with how long it took, whatever the dates say", () => {
    const v = computeClock(closure({ status: "closed", completedAt: at(11), closedAt: at(12) }), now(200));
    expect(v).toMatchObject({ state: "done", level: "grey", tookDays: 12, alertLevel: 0, paused: false });
  });

  it("uses the closing time when the case was never completed (rejected, then closed)", () => {
    expect(computeClock(closure({ status: "closed", closedAt: at(3) }), now(200))).toMatchObject({ state: "done", tookDays: 4 });
  });

  it("a rejected case still waiting to be closed keeps its clock running", () => {
    expect(computeClock(closure({ status: "rejected" }), now(22)).state).toBe("near_stop");
  });
});

describe("alerts and buckets", () => {
  it("the alert thresholds are 10, 5 and 0 days", () => {
    expect([...ALERT_THRESHOLDS]).toEqual([10, 5, 0]);
    expect(alertLevelFor(11 * DAY_MS)).toBe(0);
    expect(alertLevelFor(10 * DAY_MS)).toBe(1);
    expect(alertLevelFor(5 * DAY_MS + 1)).toBe(1);
    expect(alertLevelFor(5 * DAY_MS)).toBe(2);
    expect(alertLevelFor(1)).toBe(2);
    expect(alertLevelFor(0)).toBe(3);
    expect(alertLevelFor(-5 * DAY_MS)).toBe(3);
  });

  it("buckets match the states", () => {
    const c = closure();
    expect(inDueBucket(c, "all", now(40))).toBe(true);
    expect(inDueBucket(c, "on_track", now(1))).toBe(true);
    expect(inDueBucket(c, "on_track", now(15))).toBe(false);
    expect(inDueBucket(c, "target_passed", now(15))).toBe(true);
    expect(inDueBucket(c, "near_stop", now(21))).toBe(true);
    expect(inDueBucket(c, "breached", now(31))).toBe(true);
    expect(inDueBucket(closure({ pausedAt: at(1) }), "paused", now(31))).toBe(true);
    expect(inDueBucket(closure({ status: "closed", closedAt: at(2) }), "done", now(31))).toBe(true);
  });
});
