import { describe, expect, it } from "vitest";

import { FIXTURE_SCHEDULES } from "./business-time.fixtures";
import {
  SLA_GROUP_ORDER,
  durationParts,
  formatDuration,
  hasSla,
  matchesSlaChip,
  slaDueSortKey,
  slaGroupKey,
  targetView,
  ticketSlaView,
} from "./display";
import type { TicketSlaFields } from "./types";

const NOW = Date.parse("2026-09-20T12:00:00Z");
const iso = (minutesFromNow: number) => new Date(NOW + minutesFromNow * 60_000).toISOString();

const running = (
  frDue: number | null,
  frRisk: number | null,
  resDue: number | null = null,
  resRisk: number | null = null,
): TicketSlaFields => ({
  sla_first_response_state: frDue === null ? "none" : "running",
  sla_first_response_due_at: frDue === null ? null : iso(frDue),
  sla_first_response_risk_at: frRisk === null ? null : iso(frRisk),
  sla_resolution_state: resDue === null ? "none" : "running",
  sla_resolution_due_at: resDue === null ? null : iso(resDue),
  sla_resolution_risk_at: resRisk === null ? null : iso(resRisk),
});

describe("targetView", () => {
  it("on track, at risk, breached from the stored times", () => {
    expect(targetView("first_response", "running", iso(60), iso(40), NOW, null).state).toBe("on_track");
    expect(targetView("first_response", "running", iso(60), iso(-1), NOW, null).state).toBe("at_risk");
    expect(targetView("first_response", "running", iso(-5), iso(-20), NOW, null).state).toBe("breached");
  });

  it("does not wait for the sweep: running past due shows breached", () => {
    const v = targetView("resolution", "running", iso(-35), iso(-90), NOW, null);
    expect(v.state).toBe("breached");
    expect(v.remainingSeconds).toBe(-35 * 60);
  });

  it("remaining wall time without a schedule", () => {
    const v = targetView("first_response", "running", iso(130), iso(100), NOW, null);
    expect(v.remainingSeconds).toBe(130 * 60);
    expect(v.business).toBe(false);
  });

  it("remaining business time with a schedule", () => {
    // Monday 17:30 New York: due Tuesday 09:15 is 45 BUSINESS minutes away (15 h 45 m of wall time)
    const now = Date.parse("2026-09-14T21:30:00Z");
    const v = targetView("first_response", "running", "2026-09-15T13:15:00Z", "2026-09-15T13:00:00Z", now, FIXTURE_SCHEDULES.NY);
    expect(v.remainingSeconds).toBe(45 * 60);
    expect(v.business).toBe(true);
  });

  it("overdue in business time too", () => {
    const now = Date.parse("2026-09-15T13:50:00Z"); // 09:50 EDT
    const v = targetView("first_response", "running", "2026-09-15T13:15:00Z", "2026-09-15T13:00:00Z", now, FIXTURE_SCHEDULES.NY);
    expect(v.state).toBe("breached");
    expect(v.remainingSeconds).toBe(-35 * 60);
  });

  it("met, paused and none carry no countdown", () => {
    expect(targetView("first_response", "met", iso(10), iso(5), NOW, null)).toMatchObject({ state: "met", remainingSeconds: null });
    expect(targetView("first_response", "paused", iso(10), iso(5), NOW, null)).toMatchObject({ state: "paused", remainingSeconds: null });
    expect(targetView("first_response", "none", null, null, NOW, null).state).toBe("none");
    expect(targetView("first_response", undefined, null, null, NOW, null).state).toBe("none");
  });

  it("a stored breach stays breached even if the times look fine", () => {
    expect(targetView("first_response", "breached", iso(10), iso(5), NOW, null).state).toBe("breached");
  });
});

describe("ticketSlaView", () => {
  it("shows the most urgent target", () => {
    const v = ticketSlaView(running(60, 40, -10, -50), NOW, null);
    expect(v.overall).toBe("breached");
    expect(v.primary?.target).toBe("resolution");
  });

  it("a met first response does not hide a running resolution", () => {
    const v = ticketSlaView({ ...running(null, null, 120, 60), sla_first_response_state: "met", sla_first_response_due_at: iso(5) }, NOW, null);
    expect(v.overall).toBe("on_track");
    expect(v.primary?.target).toBe("resolution");
  });

  it("both met: met; both paused: paused; nothing: hidden", () => {
    expect(ticketSlaView({ sla_first_response_state: "met", sla_first_response_due_at: iso(1), sla_resolution_state: "met", sla_resolution_due_at: iso(9) }, NOW, null).overall).toBe("met");
    expect(ticketSlaView({ sla_first_response_state: "paused", sla_first_response_due_at: iso(1), sla_resolution_state: "paused", sla_resolution_due_at: iso(9) }, NOW, null).overall).toBe("paused");
    const none = ticketSlaView({}, NOW, null);
    expect(none.overall).toBe("none");
    expect(none.primary).toBeNull();
    expect(hasSla({})).toBe(false);
    expect(hasSla({ sla_resolution_state: "running" })).toBe(true);
  });

  it("the earlier due time wins between two on-track targets", () => {
    const v = ticketSlaView(running(30, 10, 200, 100), NOW, null);
    expect(v.primary?.target).toBe("first_response");
  });
});

describe("durations", () => {
  it("formats compactly", () => {
    expect(formatDuration(130 * 60)).toBe("2h 10m");
    expect(formatDuration(35 * 60)).toBe("35m");
    expect(formatDuration(-35 * 60)).toBe("35m");
    expect(formatDuration(2 * 3600)).toBe("2h");
    expect(formatDuration((3 * 24 + 4) * 3600)).toBe("3d 4h");
    expect(formatDuration(3 * 24 * 3600)).toBe("3d");
    expect(formatDuration(20)).toBe("<1m");
    expect(durationParts(90 * 60)).toEqual({ days: 0, hours: 1, minutes: 30, lessThanMinute: false });
  });
});

describe("filters, sort and group", () => {
  const onTrack = running(120, 100);
  const atRisk = running(30, -5);
  const breached = running(-10, -50);
  const paused: TicketSlaFields = { sla_resolution_state: "paused", sla_resolution_due_at: iso(50) };
  const none: TicketSlaFields = {};

  it("chips", () => {
    expect(matchesSlaChip("sla_at_risk", atRisk, NOW)).toBe(true);
    expect(matchesSlaChip("sla_at_risk", onTrack, NOW)).toBe(false);
    expect(matchesSlaChip("sla_at_risk", breached, NOW)).toBe(false);
    expect(matchesSlaChip("sla_breached", breached, NOW)).toBe(true);
    expect(matchesSlaChip("sla_breached", atRisk, NOW)).toBe(false);
    expect(matchesSlaChip("sla_breached", none, NOW)).toBe(false);
    // one breached target is enough even when the other is fine
    expect(matchesSlaChip("sla_breached", running(-10, -50, 500, 400), NOW)).toBe(true);
  });

  it("sort key is the earliest live due time; no SLA sorts last (null)", () => {
    expect(slaDueSortKey(running(30, 10, 500, 400), NOW)).toBe(NOW + 30 * 60_000);
    expect(slaDueSortKey(breached, NOW)).toBe(NOW - 10 * 60_000);
    expect(slaDueSortKey(paused, NOW)).toBeNull();
    expect(slaDueSortKey(none, NOW)).toBeNull();
  });

  it("groups", () => {
    expect(slaGroupKey(breached, NOW)).toBe("breached");
    expect(slaGroupKey(atRisk, NOW)).toBe("at_risk");
    expect(slaGroupKey(onTrack, NOW)).toBe("on_track");
    expect(slaGroupKey(paused, NOW)).toBe("paused");
    expect(slaGroupKey(none, NOW)).toBe("none");
    expect(SLA_GROUP_ORDER[0]).toBe("breached");
  });
});
