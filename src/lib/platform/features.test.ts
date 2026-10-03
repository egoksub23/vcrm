import { describe, expect, it } from "vitest";

import {
  DEFAULT_PLATFORM,
  applyFeatureFlags,
  isFeatureEnabled,
  limitFor,
  parsePlatformRow,
} from "./features";

describe("parsePlatformRow", () => {
  it("reads a full row", () => {
    expect(
      parsePlatformRow({
        status: "suspended",
        plan: "pro",
        limits: { seats: 10 },
        features: { incidents: false },
        suspended_reason: "unpaid",
        deletion_due_at: "2026-11-03T00:00:00Z",
      }),
    ).toEqual({
      status: "suspended",
      plan: "pro",
      limits: { seats: 10 },
      features: { incidents: false },
      suspendedReason: "unpaid",
      deletionDueAt: "2026-11-03T00:00:00Z",
    });
  });

  it("reads anything missing or malformed as the permissive default", () => {
    expect(parsePlatformRow(null)).toEqual(DEFAULT_PLATFORM);
    expect(parsePlatformRow(undefined)).toEqual(DEFAULT_PLATFORM);
    expect(parsePlatformRow("nope")).toEqual(DEFAULT_PLATFORM);
    const p = parsePlatformRow({
      status: "weird",
      plan: "",
      limits: { seats: "ten", other: -1, ok: 3 },
      features: { incidents: "no", flag: true },
    });
    expect(p.status).toBe("active");
    expect(p.plan).toBe("standard");
    expect(p.limits).toEqual({ ok: 3 });
    expect(p.features).toEqual({ flag: true });
  });
});

describe("isFeatureEnabled / limitFor", () => {
  it("is enabled unless explicitly false, and for a missing platform row", () => {
    expect(isFeatureEnabled(null, "incidents")).toBe(true);
    expect(isFeatureEnabled(DEFAULT_PLATFORM, "incidents")).toBe(true);
    expect(isFeatureEnabled(parsePlatformRow({ features: { incidents: true } }), "incidents")).toBe(true);
    expect(isFeatureEnabled(parsePlatformRow({ features: { incidents: false } }), "incidents")).toBe(false);
  });

  it("reports a limit only when one is set", () => {
    expect(limitFor(DEFAULT_PLATFORM, "seats")).toBeNull();
    expect(limitFor(parsePlatformRow({ limits: { seats: 5 } }), "seats")).toBe(5);
    expect(limitFor(null, "seats")).toBeNull();
  });
});

describe("applyFeatureFlags", () => {
  const caps = new Set(["menu.inbox", "menu.incidents", "incidents.raise", "incidents.manage", "tickets.delete"]);

  it("returns the same set untouched when nothing is disabled", () => {
    expect(applyFeatureFlags(caps, DEFAULT_PLATFORM)).toBe(caps);
    expect(applyFeatureFlags(caps, null)).toBe(caps);
  });

  it("removes every incidents capability and nothing else when incidents is off", () => {
    const out = applyFeatureFlags(caps, parsePlatformRow({ features: { incidents: false } }));
    expect([...out].sort()).toEqual(["menu.inbox", "tickets.delete"]);
    // the input is not mutated
    expect(caps.has("incidents.raise")).toBe(true);
  });

  it("removes every jira capability and nothing else when jira is off", () => {
    const withJira = new Set(["menu.inbox", "tickets.delete", "jira.connect", "jira.link", "jira.share-comments", "incidents.raise"]);
    const out = applyFeatureFlags(withJira, parsePlatformRow({ features: { jira: false } }));
    expect([...out].sort()).toEqual(["incidents.raise", "menu.inbox", "tickets.delete"]);
  });

  it("drops both modules together when both are off", () => {
    const both = new Set(["menu.incidents", "jira.link", "tickets.delete"]);
    const out = applyFeatureFlags(both, parsePlatformRow({ features: { incidents: false, jira: false } }));
    expect([...out]).toEqual(["tickets.delete"]);
  });
});
