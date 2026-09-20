import { describe, expect, it } from "vitest";

import { FIXTURE_SCHEDULES } from "./business-time.fixtures";
import {
  conditionCount,
  mapSlaDbError,
  matchPolicy,
  orderedPolicies,
  policyMatches,
  previewPolicy,
  statusForSlaError,
  validateConditions,
  validateHolidayPayload,
  validatePolicyPayload,
  validateSchedulePayload,
  type MatchInput,
} from "./policy";
import type { SlaPolicy } from "./types";

const policy = (over: Partial<SlaPolicy> & { id: string }): SlaPolicy => ({
  account_id: "a",
  name: over.id,
  position: 1,
  is_active: true,
  conditions: {},
  first_response_minutes: 30,
  resolution_minutes: null,
  schedule_id: null,
  pause_while_pending: true,
  at_risk_percent: 80,
  ...over,
});

const ticket = (over: Partial<MatchInput> = {}): MatchInput => ({
  priority: "normal",
  category: "general",
  labels: [],
  teamId: null,
  channel: null,
  ...over,
});

describe("matchPolicy (same rules as sla_match_policy in SQL)", () => {
  const urgent = policy({ id: "urgent", position: 1, conditions: { priorities: ["urgent"] } });
  const billing = policy({ id: "billing", position: 2, conditions: { categories: ["billing"] } });
  const all = policy({ id: "all", position: 3 });
  const vip = policy({ id: "vip", position: 4, conditions: { labels: ["vip"] } });
  const list = [vip, all, billing, urgent];

  it("first active policy in position order wins", () => {
    expect(matchPolicy(list, ticket({ priority: "urgent" }))?.id).toBe("urgent");
    expect(matchPolicy(list, ticket({ category: "billing" }))?.id).toBe("billing");
    expect(matchPolicy(list, ticket({ priority: "urgent", category: "billing" }))?.id).toBe("urgent");
    expect(matchPolicy(list, ticket({ category: "bug" }))?.id).toBe("all");
  });

  it("the catch-all above a label policy shadows it, until the order changes", () => {
    expect(matchPolicy(list, ticket({ labels: ["vip"] }))?.id).toBe("all");
    expect(matchPolicy([{ ...vip, position: 0 }, all, billing, urgent], ticket({ labels: ["vip"] }))?.id).toBe("vip");
  });

  it("an inactive policy is skipped; no match gives null", () => {
    expect(matchPolicy([{ ...all, is_active: false }], ticket())).toBeNull();
    expect(matchPolicy([urgent], ticket({ priority: "low" }))).toBeNull();
  });

  it("labels match on any one of them", () => {
    const p = policy({ id: "l", conditions: { labels: ["vip", "refund"] } });
    expect(policyMatches(p, ticket({ labels: ["x", "refund"] }))).toBe(true);
    expect(policyMatches(p, ticket({ labels: ["x"] }))).toBe(false);
  });

  it("channels use the conversation's channel; no conversation never matches", () => {
    const p = policy({ id: "c", conditions: { channels: ["email"] } });
    expect(policyMatches(p, ticket({ channel: "email" }))).toBe(true);
    expect(policyMatches(p, ticket({ channel: "whatsapp" }))).toBe(false);
    expect(policyMatches(p, ticket({ channel: null }))).toBe(false);
  });

  it("team condition", () => {
    const p = policy({ id: "t", conditions: { team_ids: ["t1"] } });
    expect(policyMatches(p, ticket({ teamId: "t1" }))).toBe(true);
    expect(policyMatches(p, ticket({ teamId: "t2" }))).toBe(false);
    expect(policyMatches(p, ticket({ teamId: null }))).toBe(false);
  });

  it("all conditions must hold together", () => {
    const p = policy({ id: "x", conditions: { priorities: ["high"], categories: ["bug"], team_ids: ["t1"] } });
    expect(policyMatches(p, ticket({ priority: "high", category: "bug", teamId: "t1" }))).toBe(true);
    expect(policyMatches(p, ticket({ priority: "high", category: "bug", teamId: "t2" }))).toBe(false);
  });

  it("orders by position, then oldest, then id", () => {
    const a = policy({ id: "a", position: 1, created_at: "2026-01-02" });
    const b = policy({ id: "b", position: 1, created_at: "2026-01-01" });
    const c = policy({ id: "c", position: 0 });
    expect(orderedPolicies([a, b, c]).map((p) => p.id)).toEqual(["c", "b", "a"]);
  });

  it("counts conditions", () => {
    expect(conditionCount({})).toBe(0);
    expect(conditionCount({ priorities: ["urgent"], labels: [], channels: ["email"] })).toBe(2);
    expect(conditionCount(null)).toBe(0);
  });
});

describe("validateSchedulePayload", () => {
  const good = {
    name: " Support ",
    timezone: "Asia/Kuala_Lumpur",
    weekly: { "1": [{ start: "09:00", end: "18:00" }] },
  };
  it("accepts and normalises a schedule", () => {
    const r = validateSchedulePayload(good, false);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe("Support");
      expect(Object.keys(r.value.weekly!)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
      expect(r.value.weekly!["2"]).toEqual([]);
    }
  });
  it("names the problem", () => {
    const code = (b: unknown, partial = false) => {
      const r = validateSchedulePayload(b, partial);
      return r.ok ? "ok" : r.code;
    };
    expect(code({ ...good, name: "  " })).toBe("invalid_name");
    expect(code({ ...good, timezone: "Nowhere/City" })).toBe("invalid_timezone");
    expect(code({ ...good, weekly: { "1": [{ start: "09:00", end: "12:00" }, { start: "11:00", end: "13:00" }] } })).toBe("overlap");
    expect(code({ ...good, weekly: { "1": [{ start: "12:00", end: "09:00" }] } })).toBe("end_before_start");
    expect(code({ ...good, weekly: { "1": [] } })).toBe("no_open_day");
    expect(code({ ...good, weekly: { "1": [{ start: "9:00", end: "10:00" }] } })).toBe("bad_time");
    expect(code("nope")).toBe("invalid_weekly");
  });
  it("an edit may send only some fields", () => {
    expect(validateSchedulePayload({ is_default: true }, true)).toEqual({ ok: true, value: { is_default: true } });
    expect(validateSchedulePayload({ name: "" }, true).ok).toBe(false);
  });
});

describe("validatePolicyPayload", () => {
  const ok = { name: "Urgent", conditions: { priorities: ["urgent"] }, first_response_minutes: 30, resolution_minutes: 240 };
  const code = (b: unknown, partial = false) => {
    const r = validatePolicyPayload(b, partial);
    return r.ok ? "ok" : r.code;
  };
  it("accepts a good policy", () => {
    expect(code(ok)).toBe("ok");
    expect(code({ ...ok, resolution_minutes: undefined })).toBe("ok");
    expect(code({ ...ok, first_response_minutes: undefined })).toBe("ok");
  });
  it("needs at least one target, resolution after first response", () => {
    expect(code({ name: "x" })).toBe("invalid_targets");
    expect(code({ ...ok, first_response_minutes: 120, resolution_minutes: 60 })).toBe("targets_order");
    expect(code({ ...ok, first_response_minutes: 60, resolution_minutes: 60 })).toBe("targets_order");
    expect(code({ ...ok, first_response_minutes: 0 })).toBe("invalid_targets");
    expect(code({ ...ok, first_response_minutes: 1.5 })).toBe("invalid_targets");
    expect(code({ ...ok, first_response_minutes: 600_000 })).toBe("invalid_targets");
  });
  it("at-risk percent is 50 to 95", () => {
    expect(code({ ...ok, at_risk_percent: 49 })).toBe("invalid_percent");
    expect(code({ ...ok, at_risk_percent: 96 })).toBe("invalid_percent");
    expect(code({ ...ok, at_risk_percent: 50 })).toBe("ok");
    expect(code({ ...ok, at_risk_percent: 95 })).toBe("ok");
  });
  it("validates the schedule id and the name", () => {
    expect(code({ ...ok, schedule_id: "nope" })).toBe("schedule_missing");
    expect(code({ ...ok, schedule_id: null })).toBe("ok");
    expect(code({ ...ok, name: "" })).toBe("invalid_name");
    expect(code({ ...ok, name: "x".repeat(81) })).toBe("invalid_name");
  });
  it("a partial edit only checks what it sends", () => {
    expect(code({ is_active: false }, true)).toBe("ok");
    expect(code({ is_active: "no" }, true)).toBe("invalid_name");
    expect(code({ first_response_minutes: null }, true)).toBe("ok");
  });
});

describe("validateConditions", () => {
  it("keeps only non-empty lists, normalises labels, drops duplicates", () => {
    const r = validateConditions({ priorities: ["urgent", "urgent"], labels: ["  VIP ", "vip"], channels: [] });
    expect(r).toEqual({ ok: true, value: { priorities: ["urgent"], labels: ["vip"] } });
  });
  it("rejects unknown keys and values", () => {
    expect(validateConditions({ colour: ["red"] }).ok).toBe(false);
    expect(validateConditions({ priorities: ["asap"] }).ok).toBe(false);
    expect(validateConditions({ categories: ["stuff"] }).ok).toBe(false);
    expect(validateConditions({ team_ids: ["not-a-uuid"] }).ok).toBe(false);
    expect(validateConditions("x").ok).toBe(false);
    expect(validateConditions({ labels: Array.from({ length: 51 }, (_, i) => `l${i}`) }).ok).toBe(false);
  });
  it("nothing sent means any ticket", () => {
    expect(validateConditions(undefined)).toEqual({ ok: true, value: {} });
    expect(validateConditions(null)).toEqual({ ok: true, value: {} });
  });
});

describe("validateHolidayPayload", () => {
  it("takes a real date and an optional name", () => {
    expect(validateHolidayPayload({ date: "2026-12-25", name: " Christmas " })).toEqual({
      ok: true,
      value: { holiday_date: "2026-12-25", name: "Christmas" },
    });
    expect(validateHolidayPayload({ holiday_date: "2026-01-01" })).toEqual({
      ok: true,
      value: { holiday_date: "2026-01-01", name: "" },
    });
  });
  it("refuses dates that do not exist", () => {
    expect(validateHolidayPayload({ date: "2026-02-30" }).ok).toBe(false);
    expect(validateHolidayPayload({ date: "26-1-1" }).ok).toBe(false);
    expect(validateHolidayPayload(null).ok).toBe(false);
  });
});

describe("mapSlaDbError", () => {
  it("turns database errors into codes", () => {
    expect(mapSlaDbError({ code: "42501" })).toBe("forbidden");
    expect(mapSlaDbError({ code: "23505" })).toBe("duplicate_holiday");
    expect(mapSlaDbError({ code: "54000" })).toBe("policy_limit");
    expect(mapSlaDbError({ code: "22023", message: "sla_timezone_invalid: X" })).toBe("invalid_timezone");
    expect(mapSlaDbError({ code: "22023", message: "sla_weekly_invalid: overlap (day 2)" })).toBe("overlap");
    expect(mapSlaDbError({ code: "22023", message: "sla_default_required" })).toBe("default_required");
    expect(mapSlaDbError({ code: "22023", message: "sla_conditions_invalid: priority asap" })).toBe("invalid_conditions");
    expect(mapSlaDbError({ code: "23514", message: 'violates check constraint "ticket_sla_policies_order"' })).toBe("targets_order");
    expect(mapSlaDbError({ code: "23514", message: "at_risk_percent" })).toBe("invalid_percent");
    expect(
      mapSlaDbError({
        code: "23503",
        message:
          'update or delete on table "business_hours_schedules" violates foreign key constraint "ticket_sla_policies_schedule_id_fkey"',
      }),
    ).toBe("schedule_in_use");
    expect(mapSlaDbError({ code: "23503", message: "sla_schedule_missing" })).toBe("schedule_missing");
    expect(mapSlaDbError(null)).toBe("failed");
  });
  it("has an http status for every family", () => {
    expect(statusForSlaError("forbidden")).toBe(403);
    expect(statusForSlaError("schedule_in_use")).toBe(409);
    expect(statusForSlaError("invalid_name")).toBe(400);
    expect(statusForSlaError("failed")).toBe(500);
  });
});

describe("previewPolicy", () => {
  it("24/7: due is created + target", () => {
    const now = new Date("2026-09-20T12:00:00Z");
    const p = previewPolicy({ first_response_minutes: 30, resolution_minutes: 240, conditions: { priorities: ["urgent"] } }, null, now);
    expect(p.priority).toBe("urgent");
    expect(p.timezone).toBeNull();
    expect(p.firstResponseDue!.toISOString()).toBe("2026-09-20T12:30:00.000Z");
    expect(p.resolutionDue!.toISOString()).toBe("2026-09-20T16:00:00.000Z");
    expect(p.startedOutsideHours).toBe(false);
  });

  it("business hours: a Monday 17:30 ticket waits for Tuesday morning", () => {
    const now = new Date("2026-09-20T12:00:00Z"); // Sunday
    const p = previewPolicy(
      { first_response_minutes: 45, resolution_minutes: 480, conditions: {} },
      FIXTURE_SCHEDULES.NY,
      now,
    );
    expect(p.priority).toBe("normal");
    expect(p.timezone).toBe("America/New_York");
    expect(p.createdAt.toISOString()).toBe("2026-09-21T21:30:00.000Z"); // Mon 17:30 EDT
    expect(p.firstResponseDue!.toISOString()).toBe("2026-09-22T13:15:00.000Z"); // Tue 09:15 EDT
    expect(p.resolutionDue!.toISOString()).toBe("2026-09-22T20:30:00.000Z"); // 30 + 450 min
    expect(p.startedOutsideHours).toBe(false); // 17:30 is still open on Monday
    expect(p.createdLocal).toEqual({ weekday: 1, hh: "17", mm: "30" });
  });

  it("a schedule that is closed on Monday evening says so", () => {
    const p = previewPolicy(
      { first_response_minutes: 30, resolution_minutes: null, conditions: {} },
      FIXTURE_SCHEDULES.KL,
      new Date("2026-09-20T12:00:00Z"),
    );
    expect(p.startedOutsideHours).toBe(true);
    expect(p.resolutionDue).toBeNull();
  });

  it("uses the following Monday when this Monday 17:30 has passed", () => {
    const p = previewPolicy(
      { first_response_minutes: 30, resolution_minutes: null, conditions: {} },
      FIXTURE_SCHEDULES.NY,
      new Date("2026-09-21T23:00:00Z"), // Monday 19:00 EDT
    );
    expect(p.createdAt.toISOString()).toBe("2026-09-28T21:30:00.000Z");
  });
});
