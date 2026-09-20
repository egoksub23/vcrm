import { describe, expect, it } from "vitest";

import {
  addBusinessMinutes,
  addBusinessSeconds,
  businessMinutesBetween,
  businessSecondsBetween,
  isOpenAt,
  isValidTimezone,
  nextOpening,
  parseHm,
  splitMinutes,
  toMinutes,
  validateWeekly,
  zonedToInstant,
  MON_FRI_9_TO_18,
} from "./business-time";
import { ADD_CASES, BETWEEN_CASES, FIXTURE_SCHEDULES } from "./business-time.fixtures";

const sched = (key: string | null) => (key === null ? null : FIXTURE_SCHEDULES[key]);
const iso = (d: Date | null) => (d === null ? null : d.toISOString().replace(".000Z", "Z"));

describe("addBusinessMinutes: parity fixtures (same cases as verify-086)", () => {
  for (const c of ADD_CASES) {
    it(c.name, () => {
      expect(iso(addBusinessMinutes(sched(c.schedule), new Date(c.from), c.minutes))).toBe(c.expected);
    });
  }
});

describe("businessMinutesBetween: parity fixtures (same cases as verify-086)", () => {
  for (const c of BETWEEN_CASES) {
    it(c.name, () => {
      expect(businessMinutesBetween(sched(c.schedule), new Date(c.from), new Date(c.to))).toBe(c.expected);
    });
  }
});

describe("round trip", () => {
  it("between(from, add(from, n)) is n for a start inside hours", () => {
    const ny = FIXTURE_SCHEDULES.NY;
    const from = new Date("2026-09-14T14:00:00Z");
    for (const n of [1, 59, 60, 540, 541, 1000, 5000]) {
      const to = addBusinessMinutes(ny, from, n);
      expect(to).not.toBeNull();
      expect(businessMinutesBetween(ny, from, to!)).toBe(n);
    }
  });

  it("an add never returns an instant before the start", () => {
    const from = new Date("2026-09-12T15:00:00Z").getTime();
    expect(addBusinessSeconds(FIXTURE_SCHEDULES.NY, from, 1)).toBeGreaterThan(from);
  });

  it("negative seconds are refused", () => {
    expect(addBusinessSeconds(FIXTURE_SCHEDULES.NY, 0, -1)).toBeNull();
  });

  it("business seconds keep sub-minute precision", () => {
    const from = new Date("2026-09-15T13:00:00Z").getTime();
    expect(addBusinessSeconds(FIXTURE_SCHEDULES.NY, from, 90)).toBe(from + 90_000);
    expect(businessSecondsBetween(FIXTURE_SCHEDULES.NY, from, from + 90_500)).toBe(90);
  });
});

describe("opening hours helpers", () => {
  const ny = FIXTURE_SCHEDULES.NY;
  it("isOpenAt treats the end instant as closed and the start as open", () => {
    expect(isOpenAt(ny, new Date("2026-09-15T13:00:00Z").getTime())).toBe(true); // 09:00
    expect(isOpenAt(ny, new Date("2026-09-15T21:59:59Z").getTime())).toBe(true);
    expect(isOpenAt(ny, new Date("2026-09-15T22:00:00Z").getTime())).toBe(false); // 18:00
    expect(isOpenAt(ny, new Date("2026-09-12T15:00:00Z").getTime())).toBe(false); // Saturday
    expect(isOpenAt(ny, new Date("2026-09-07T15:00:00Z").getTime())).toBe(false); // holiday
    expect(isOpenAt(null, 0)).toBe(true);
  });

  it("nextOpening moves to the next slot start", () => {
    expect(new Date(nextOpening(ny, new Date("2026-09-12T15:00:00Z").getTime())!).toISOString()).toBe(
      "2026-09-14T13:00:00.000Z",
    );
    const t = new Date("2026-09-15T15:00:00Z").getTime();
    expect(nextOpening(ny, t)).toBe(t);
  });
});

describe("zonedToInstant resolves gaps and overlaps like Postgres", () => {
  it("New York spring-forward gap 02:30 -> 07:30Z", () => {
    expect(new Date(zonedToInstant(2026, 3, 8, 2 * 60 + 30, "America/New_York")).toISOString()).toBe(
      "2026-03-08T07:30:00.000Z",
    );
  });
  it("New York fall-back overlap 01:30 -> the standard-time one, 06:30Z", () => {
    expect(new Date(zonedToInstant(2026, 11, 1, 60 + 30, "America/New_York")).toISOString()).toBe(
      "2026-11-01T06:30:00.000Z",
    );
  });
  it("Sydney gap and overlap", () => {
    expect(new Date(zonedToInstant(2026, 10, 4, 150, "Australia/Sydney")).toISOString()).toBe("2026-10-03T16:30:00.000Z");
    expect(new Date(zonedToInstant(2026, 4, 5, 150, "Australia/Sydney")).toISOString()).toBe("2026-04-04T16:30:00.000Z");
  });
  it("24:00 is the next midnight", () => {
    expect(new Date(zonedToInstant(2026, 9, 14, 1440, "UTC")).toISOString()).toBe("2026-09-15T00:00:00.000Z");
  });
});

describe("24:00 slot ends", () => {
  it("a day open 00:00-24:00 is continuous across midnight", () => {
    const all: Record<string, { start: string; end: string }[]> = {};
    for (const d of ["1", "2", "3", "4", "5", "6", "7"]) all[d] = [{ start: "00:00", end: "24:00" }];
    const s = { timezone: "UTC", weekly: all };
    const from = new Date("2026-09-14T23:30:00Z");
    expect(iso(addBusinessMinutes(s, from, 60))).toBe("2026-09-15T00:30:00Z");
  });
});

describe("validateWeekly", () => {
  it("accepts Monday to Friday", () => {
    expect(validateWeekly(MON_FRI_9_TO_18)).toEqual([]);
  });
  it("rejects overlap, reversed times, bad times, too many slots and an empty week", () => {
    expect(validateWeekly({ "1": [{ start: "09:00", end: "12:00" }, { start: "11:00", end: "13:00" }] }).map((e) => e.code)).toContain(
      "overlap",
    );
    expect(validateWeekly({ "1": [{ start: "12:00", end: "09:00" }] }).map((e) => e.code)).toContain("end_before_start");
    expect(validateWeekly({ "1": [{ start: "9:00", end: "10:00" }] }).map((e) => e.code)).toContain("bad_time");
    expect(validateWeekly({ "1": [{ start: "24:00", end: "24:00" }] }).map((e) => e.code)).toContain("bad_time");
    expect(
      validateWeekly({
        "1": [1, 2, 3, 4, 5].map((i) => ({ start: `0${i}:00`, end: `0${i}:30` })),
      }).map((e) => e.code),
    ).toContain("too_many_slots");
    expect(validateWeekly({ "1": [], "2": [] }).map((e) => e.code)).toContain("no_open_day");
    expect(validateWeekly({ "8": [{ start: "09:00", end: "10:00" }] }).map((e) => e.code)).toContain("bad_day");
    expect(validateWeekly(null).map((e) => e.code)).toContain("bad_day");
  });
  it("touching slots are fine", () => {
    expect(
      validateWeekly({ "1": [{ start: "09:00", end: "12:00" }, { start: "12:00", end: "13:00" }] }),
    ).toEqual([]);
  });
});

describe("small helpers", () => {
  it("parses HH:MM", () => {
    expect(parseHm("09:30")).toBe(570);
    expect(parseHm("24:00")).toBe(1440);
    expect(parseHm("24:01")).toBeNull();
    expect(parseHm("9:30")).toBeNull();
    expect(parseHm(null)).toBeNull();
  });
  it("validates zones", () => {
    expect(isValidTimezone("Asia/Kuala_Lumpur")).toBe(true);
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });
  it("converts target units", () => {
    expect(splitMinutes(90)).toEqual({ value: 90, unit: "minutes" });
    expect(splitMinutes(120)).toEqual({ value: 2, unit: "hours" });
    expect(splitMinutes(2880)).toEqual({ value: 2, unit: "days" });
    expect(toMinutes(2, "days")).toBe(2880);
    expect(toMinutes(1.5, "hours")).toBe(90);
  });
});
