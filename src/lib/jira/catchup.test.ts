import { describe, expect, it } from "vitest";

import {
  buildCatchupJql,
  buildWebhookJql,
  catchupWindowMinutes,
  CATCHUP_MAX_WINDOW_MINUTES,
  CATCHUP_OVERLAP_MINUTES,
  chunkIds,
  classifyJobError,
  retryDelaySeconds,
} from "./catchup";
import { JiraAuthError, JiraNotFoundError, JiraPermissionError, JiraRateLimitError, JiraServerError, JiraValidationError } from "./errors";

const NOW = new Date("2026-09-20T10:00:00Z");

describe("catch-up window", () => {
  it("is the gap plus a two minute overlap, as a RELATIVE JQL time", () => {
    expect(catchupWindowMinutes(new Date(NOW.getTime() - 5 * 60_000), NOW)).toBe(5 + CATCHUP_OVERLAP_MINUTES);
    expect(buildCatchupJql(["10001", "10002"], 7)).toBe("id in (10001,10002) AND updated >= -7m");
  });

  it("re-reads everything on the first run and after a long gap", () => {
    expect(catchupWindowMinutes(null, NOW)).toBeNull();
    expect(catchupWindowMinutes(new Date(NOW.getTime() - (CATCHUP_MAX_WINDOW_MINUTES + 10) * 60_000), NOW)).toBeNull();
    expect(catchupWindowMinutes(new Date(NOW.getTime() + 60_000), NOW)).toBeNull(); // a clock in the future
    expect(buildCatchupJql(["10001"], null)).toBe("id in (10001)");
  });

  it("never lets anything but digits into the JQL", () => {
    expect(buildCatchupJql(["10001", "1) OR (project = X", "abc", "12 34"], 5)).toBe("id in (10001) AND updated >= -5m");
    expect(chunkIds(["1", "x", "2"])).toEqual([["1", "2"]]);
  });

  it("chunks long id lists to keep every JQL short", () => {
    const ids = Array.from({ length: 1000 }, (_, i) => String(100000 + i));
    const chunks = chunkIds(ids, 100, 1500);
    expect(chunks.flat()).toEqual(ids);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(100);
      expect(buildCatchupJql(c, 10).length).toBeLessThan(1600);
    }
    expect(chunks.length).toBeGreaterThanOrEqual(10);
    // a character budget splits before the count does
    expect(chunkIds(["1234567890123456", "1234567890123456", "1234567890123456"], 100, 40)).toHaveLength(2);
    expect(chunkIds([])).toEqual([]);
  });

  it("builds the webhook filter from project keys only", () => {
    expect(buildWebhookJql(["ENG", "WEB"])).toBe("project in (ENG,WEB)");
    expect(buildWebhookJql([])).toBe("");
    expect(buildWebhookJql(["ENG", "x) OR (1=1", "bad key"])).toBe("project in (ENG)");
  });
});

describe("job retry policy", () => {
  it("backs off from 30 s, doubling to a 30 minute cap, with jitter", () => {
    const mid = () => 0.5;
    expect(retryDelaySeconds(1, mid)).toBe(30);
    expect(retryDelaySeconds(2, mid)).toBe(60);
    expect(retryDelaySeconds(3, mid)).toBe(120);
    expect(retryDelaySeconds(30, mid)).toBe(1800);
    expect(retryDelaySeconds(1, () => 0)).toBe(23);
    expect(retryDelaySeconds(1, () => 1)).toBe(38);
  });

  it("retries what may pass and dead-letters what never will", () => {
    expect(classifyJobError(new JiraServerError(), 1, () => 0.5)).toEqual({ outcome: "retry", seconds: 30 });
    expect(classifyJobError(new JiraRateLimitError(90_000), 1)).toEqual({ outcome: "retry", seconds: 90 });
    expect(classifyJobError(new JiraRateLimitError(200), 1)).toEqual({ outcome: "retry", seconds: 5 });
    expect(classifyJobError(new JiraRateLimitError(99_999_999), 1)).toEqual({ outcome: "retry", seconds: 3600 });
    expect(classifyJobError(new JiraPermissionError(), 1)).toEqual({ outcome: "dead" }); // no retry storm
    expect(classifyJobError(new JiraNotFoundError(), 1)).toEqual({ outcome: "dead" });
    expect(classifyJobError(new JiraValidationError(["bad"]), 1)).toEqual({ outcome: "dead" });
    expect(classifyJobError(new JiraAuthError(), 1)).toEqual({ outcome: "dead" });
    expect(classifyJobError(new Error("a bug"), 2, () => 0.5)).toEqual({ outcome: "retry", seconds: 60 });
  });
});
