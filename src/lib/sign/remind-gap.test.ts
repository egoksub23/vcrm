import { describe, expect, it } from "vitest";

import { REMIND_GAP_MS, remindHeldUntil } from "./defaults";

describe("remindHeldUntil (the 24-hour rule for a manual reminder)", () => {
  const now = new Date("2026-10-06T12:00:00Z");

  it("lets the first reminder go", () => {
    expect(remindHeldUntil(null, now)).toBeNull();
    expect(remindHeldUntil(undefined, now)).toBeNull();
    expect(remindHeldUntil("not a date", now)).toBeNull();
  });

  it("holds a reminder until 24 hours after the last one, and says when", () => {
    const last = "2026-10-06T08:00:00Z";
    expect(remindHeldUntil(last, now)?.toISOString()).toBe("2026-10-07T08:00:00.000Z");
    expect(REMIND_GAP_MS).toBe(24 * 3600 * 1000);
  });

  it("lets it go again exactly at, and after, the 24 hours", () => {
    expect(remindHeldUntil("2026-10-05T12:00:00Z", now)).toBeNull();
    expect(remindHeldUntil("2026-10-04T12:00:00Z", now)).toBeNull();
    expect(remindHeldUntil("2026-10-05T12:00:01Z", now)).not.toBeNull();
  });
});
