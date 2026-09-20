import { describe, expect, it } from "vitest";

import { MON_FRI_9_TO_18 } from "./business-time";
import { slotsText, summarizeWeekly } from "./summary";

describe("summarizeWeekly", () => {
  it("groups consecutive days with the same hours", () => {
    expect(summarizeWeekly(MON_FRI_9_TO_18)).toEqual([{ from: 1, to: 5, hours: "09:00-18:00" }]);
  });

  it("splits when the hours differ or a day is closed", () => {
    const weekly = {
      "1": [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "17:00" }],
      "2": [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "17:00" }],
      "3": [],
      "4": [{ start: "10:00", end: "14:00" }],
      "6": [{ start: "10:00", end: "14:00" }],
    };
    expect(summarizeWeekly(weekly)).toEqual([
      { from: 1, to: 2, hours: "09:00-12:00, 13:00-17:00" },
      { from: 4, to: 4, hours: "10:00-14:00" },
      { from: 6, to: 6, hours: "10:00-14:00" },
    ]);
  });

  it("an empty week has no groups", () => {
    expect(summarizeWeekly({})).toEqual([]);
    expect(slotsText({}, 1)).toBe("");
  });
});
