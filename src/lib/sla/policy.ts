// ============================================================
// SLA policies: matching, input validation, database error mapping and the
// live preview sentence. Pure, no I/O.
//
// `matchPolicy` is the TypeScript twin of the SQL `sla_match_policy`
// (migration 086): the first ACTIVE policy in position order whose non-empty
// conditions all match. labels: the ticket has ANY of the listed labels.
// channels: the linked conversation's last_channel_type (a ticket with no
// conversation never matches a policy that names channels).
// ============================================================

import type { TicketCategory, TicketPriority } from "@/types";
import { TICKET_CATEGORIES, TICKET_PRIORITIES } from "@/lib/tickets/constants";
import { normalizeLabel } from "@/lib/tickets/labels";
import {
  MAX_SLOTS_PER_DAY,
  addBusinessSeconds,
  isValidTimezone,
  localParts,
  validateWeekly,
  zonedToInstant,
  type BusinessSchedule,
  type WeeklyHours,
} from "./business-time";
import {
  SLA_LIMITS,
  type PolicyConditions,
  type SlaErrorCode,
  type SlaPolicy,
  type SlaSchedule,
} from "./types";

// ---- Matching -----------------------------------------------------------------

export interface MatchInput {
  priority: TicketPriority;
  category: TicketCategory;
  labels: readonly string[];
  teamId: string | null;
  /** The linked conversation's last_channel_type, or null with no conversation. */
  channel: string | null;
}

function anyOf(list: readonly string[] | undefined, value: string | null): boolean {
  if (!list || list.length === 0) return true;
  return value !== null && list.includes(value);
}

export function policyMatches(p: Pick<SlaPolicy, "conditions" | "is_active">, t: MatchInput): boolean {
  if (!p.is_active) return false;
  const c = p.conditions ?? {};
  if (!anyOf(c.priorities, t.priority)) return false;
  if (!anyOf(c.categories, t.category)) return false;
  if (c.labels && c.labels.length > 0 && !c.labels.some((l) => t.labels.includes(l))) return false;
  if (!anyOf(c.channels, t.channel)) return false;
  if (!anyOf(c.team_ids, t.teamId)) return false;
  return true;
}

/** Policies in evaluation order: position, then oldest first. */
export function orderedPolicies<T extends Pick<SlaPolicy, "position" | "id"> & { created_at?: string }>(
  policies: readonly T[],
): T[] {
  return [...policies].sort(
    (a, b) =>
      a.position - b.position ||
      (a.created_at ?? "").localeCompare(b.created_at ?? "") ||
      a.id.localeCompare(b.id),
  );
}

export function matchPolicy<T extends SlaPolicy>(policies: readonly T[], ticket: MatchInput): T | null {
  return orderedPolicies(policies).find((p) => policyMatches(p, ticket)) ?? null;
}

/** How many conditions a policy has (0 = matches everything). */
export function conditionCount(c: PolicyConditions | null | undefined): number {
  if (!c) return 0;
  return (["priorities", "categories", "labels", "channels", "team_ids"] as const).filter(
    (k) => (c[k]?.length ?? 0) > 0,
  ).length;
}

// ---- Input validation ---------------------------------------------------------------

export type Checked<T> = { ok: true; value: T } | { ok: false; code: SlaErrorCode };

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function cleanName(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const name = v.trim();
  return name.length >= 1 && name.length <= max ? name : null;
}

export interface SchedulePayload {
  name?: string;
  timezone?: string;
  weekly?: WeeklyHours;
  is_default?: boolean;
}

/** Turn a weekly validation error code into the API error code. */
function weeklyCode(code: string): SlaErrorCode {
  switch (code) {
    case "overlap":
    case "too_many_slots":
    case "bad_time":
    case "end_before_start":
    case "no_open_day":
      return code;
    default:
      return "invalid_weekly";
  }
}

/** A create (`partial` false) or edit (`partial` true) of a schedule. */
export function validateSchedulePayload(body: unknown, partial: boolean): Checked<SchedulePayload> {
  if (!isObject(body)) return { ok: false, code: "invalid_weekly" };
  const out: SchedulePayload = {};
  if (!partial || body.name !== undefined) {
    const name = cleanName(body.name, SLA_LIMITS.maxNameLength);
    if (name === null) return { ok: false, code: "invalid_name" };
    out.name = name;
  }
  if (!partial || body.timezone !== undefined) {
    if (typeof body.timezone !== "string" || !isValidTimezone(body.timezone)) {
      return { ok: false, code: "invalid_timezone" };
    }
    out.timezone = body.timezone;
  }
  if (!partial || body.weekly !== undefined) {
    const errors = validateWeekly(body.weekly);
    if (errors.length > 0) return { ok: false, code: weeklyCode(errors[0].code) };
    out.weekly = normalizeWeekly(body.weekly as WeeklyHours);
  }
  if (body.is_default !== undefined) {
    if (typeof body.is_default !== "boolean") return { ok: false, code: "invalid_weekly" };
    out.is_default = body.is_default;
  }
  return { ok: true, value: out };
}

/** Only keys 1..7, slots sorted by start, nothing else carried along. */
export function normalizeWeekly(weekly: WeeklyHours): WeeklyHours {
  const out: WeeklyHours = {};
  for (const day of ["1", "2", "3", "4", "5", "6", "7"]) {
    const slots = [...(weekly[day] ?? [])]
      .map((s) => ({ start: s.start, end: s.end }))
      .sort((a, b) => a.start.localeCompare(b.start));
    out[day] = slots.slice(0, MAX_SLOTS_PER_DAY);
  }
  return out;
}

export interface PolicyPayload {
  name?: string;
  is_active?: boolean;
  conditions?: PolicyConditions;
  first_response_minutes?: number | null;
  resolution_minutes?: number | null;
  schedule_id?: string | null;
  pause_while_pending?: boolean;
  at_risk_percent?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

function list(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > SLA_LIMITS.maxListEntries) return null;
  if (!v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 64)) return null;
  return [...new Set(v as string[])];
}

export function validateConditions(v: unknown): Checked<PolicyConditions> {
  if (v === undefined || v === null) return { ok: true, value: {} };
  if (!isObject(v)) return { ok: false, code: "invalid_conditions" };
  const out: PolicyConditions = {};
  for (const key of Object.keys(v)) {
    if (!["priorities", "categories", "labels", "channels", "team_ids"].includes(key)) {
      return { ok: false, code: "invalid_conditions" };
    }
  }
  const priorities = list(v.priorities);
  const categories = list(v.categories);
  const labels = list(v.labels);
  const channels = list(v.channels);
  const teams = list(v.team_ids);
  if (!priorities || !categories || !labels || !channels || !teams) return { ok: false, code: "invalid_conditions" };
  if (!priorities.every((p) => (TICKET_PRIORITIES as string[]).includes(p))) return { ok: false, code: "invalid_conditions" };
  if (!categories.every((c) => (TICKET_CATEGORIES as string[]).includes(c))) return { ok: false, code: "invalid_conditions" };
  if (!teams.every(isUuid)) return { ok: false, code: "invalid_conditions" };
  if (priorities.length) out.priorities = priorities as TicketPriority[];
  if (categories.length) out.categories = categories as TicketCategory[];
  const normLabels = [...new Set(labels.map(normalizeLabel).filter(Boolean))];
  if (normLabels.length) out.labels = normLabels;
  if (channels.length) out.channels = channels;
  if (teams.length) out.team_ids = teams;
  return { ok: true, value: out };
}

function minutesOrNull(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > SLA_LIMITS.maxTargetMinutes) return undefined;
  return v;
}

/**
 * A create (`partial` false) or edit (`partial` true) of a policy. On an edit
 * the target rules that involve BOTH targets are re-checked by the database.
 */
export function validatePolicyPayload(body: unknown, partial: boolean): Checked<PolicyPayload> {
  if (!isObject(body)) return { ok: false, code: "invalid_name" };
  const out: PolicyPayload = {};
  if (!partial || body.name !== undefined) {
    const name = cleanName(body.name, SLA_LIMITS.maxNameLength);
    if (name === null) return { ok: false, code: "invalid_name" };
    out.name = name;
  }
  if (body.is_active !== undefined) {
    if (typeof body.is_active !== "boolean") return { ok: false, code: "invalid_name" };
    out.is_active = body.is_active;
  }
  if (!partial || body.conditions !== undefined) {
    const c = validateConditions(body.conditions);
    if (!c.ok) return c;
    out.conditions = c.value;
  }
  for (const key of ["first_response_minutes", "resolution_minutes"] as const) {
    if (body[key] !== undefined) {
      const m = minutesOrNull(body[key]);
      if (m === undefined) return { ok: false, code: "invalid_targets" };
      out[key] = m;
    }
  }
  if (!partial || body.first_response_minutes !== undefined || body.resolution_minutes !== undefined) {
    const fr = out.first_response_minutes ?? null;
    const res = out.resolution_minutes ?? null;
    if (!partial) {
      if (fr === null && res === null) return { ok: false, code: "invalid_targets" };
    }
    if (fr !== null && res !== null && res <= fr) return { ok: false, code: "targets_order" };
  }
  if (body.schedule_id !== undefined) {
    if (body.schedule_id !== null && !isUuid(body.schedule_id)) return { ok: false, code: "schedule_missing" };
    out.schedule_id = body.schedule_id as string | null;
  }
  if (body.pause_while_pending !== undefined) {
    if (typeof body.pause_while_pending !== "boolean") return { ok: false, code: "invalid_targets" };
    out.pause_while_pending = body.pause_while_pending;
  }
  if (body.at_risk_percent !== undefined) {
    const p = body.at_risk_percent;
    if (typeof p !== "number" || !Number.isInteger(p) || p < SLA_LIMITS.atRiskMin || p > SLA_LIMITS.atRiskMax) {
      return { ok: false, code: "invalid_percent" };
    }
    out.at_risk_percent = p;
  }
  return { ok: true, value: out };
}

export function validateHolidayPayload(body: unknown): Checked<{ holiday_date: string; name: string }> {
  if (!isObject(body)) return { ok: false, code: "invalid_date" };
  const date = body.date ?? body.holiday_date;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, code: "invalid_date" };
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) return { ok: false, code: "invalid_date" };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length > SLA_LIMITS.maxHolidayNameLength) return { ok: false, code: "invalid_name" };
  return { ok: true, value: { holiday_date: date, name } };
}

// ---- Database errors -------------------------------------------------------------------

/** Map a PostgREST / Postgres error from the SLA tables to a translatable code. */
export function mapSlaDbError(err: { code?: string | null; message?: string | null } | null | undefined): SlaErrorCode {
  const code = err?.code ?? "";
  const message = err?.message ?? "";
  if (code === "42501") return "forbidden";
  if (code === "23503") {
    // Deleting a schedule a policy still uses, versus pointing at one that is not there.
    return message.includes("update or delete on table") ? "schedule_in_use" : "schedule_missing";
  }
  if (code === "23505") return "duplicate_holiday";
  if (code === "54000") return "policy_limit";
  if (code === "23514") {
    if (message.includes("ticket_sla_policies_order")) return "targets_order";
    if (message.includes("at_risk_percent")) return "invalid_percent";
    return "invalid_targets";
  }
  if (code === "22023" || code === "P0001") {
    if (message.includes("sla_timezone_invalid")) return "invalid_timezone";
    if (message.includes("sla_default_required")) return "default_required";
    if (message.includes("sla_conditions_invalid")) return "invalid_conditions";
    const m = /sla_weekly_invalid: (\w+)/.exec(message);
    if (m) return weeklyCode(m[1]);
  }
  return "failed";
}

/** HTTP status for a code. */
export function statusForSlaError(code: SlaErrorCode): number {
  switch (code) {
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "schedule_in_use":
    case "duplicate_holiday":
    case "default_required":
      return 409;
    case "failed":
      return 500;
    default:
      return 400;
  }
}

// ---- Live preview ------------------------------------------------------------------------

export interface PolicyPreview {
  /** The sample priority the sentence talks about. */
  priority: TicketPriority;
  timezone: string | null;
  /** The instant the sample ticket is created (Monday 17:30 in the zone, or now for 24/7). */
  createdAt: Date;
  /** Local weekday/time the ticket is created in the schedule's zone (null for 24/7). */
  createdLocal: { weekday: number; hh: string; mm: string } | null;
  firstResponseDue: Date | null;
  resolutionDue: Date | null;
  /** True when the schedule is closed at the moment the sample ticket is created. */
  startedOutsideHours: boolean;
}

/**
 * The sentence behind the policy dialog: "an urgent ticket created Monday
 * 17:30 in <zone> is due to be answered by ... and resolved by ...". With a
 * schedule it uses the next Monday 17:30 in the schedule's zone (after work,
 * so the wait for the next opening shows); without one (24/7) it uses `now`.
 */
export function previewPolicy(
  policy: Pick<SlaPolicy, "first_response_minutes" | "resolution_minutes" | "conditions">,
  schedule: (BusinessSchedule & { name?: string }) | null,
  now: Date = new Date(),
): PolicyPreview {
  const priority = policy.conditions?.priorities?.[0] ?? "normal";
  if (!schedule) {
    const created = now;
    return {
      priority,
      timezone: null,
      createdAt: created,
      createdLocal: null,
      firstResponseDue:
        policy.first_response_minutes === null
          ? null
          : new Date(addBusinessSeconds(null, created.getTime(), policy.first_response_minutes * 60)!),
      resolutionDue:
        policy.resolution_minutes === null
          ? null
          : new Date(addBusinessSeconds(null, created.getTime(), policy.resolution_minutes * 60)!),
      startedOutsideHours: false,
    };
  }
  // next Monday 17:30 local, strictly after now
  const here = localParts(now.getTime(), schedule.timezone);
  let daysAhead = (1 - here.weekday + 7) % 7;
  let target = addDaysLocal(here.year, here.month, here.day, daysAhead);
  let createdMs = zonedToInstant(target.y, target.m, target.d, 17 * 60 + 30, schedule.timezone);
  if (createdMs <= now.getTime()) {
    daysAhead += 7;
    target = addDaysLocal(here.year, here.month, here.day, daysAhead);
    createdMs = zonedToInstant(target.y, target.m, target.d, 17 * 60 + 30, schedule.timezone);
  }
  const due = (minutes: number | null) => {
    if (minutes === null) return null;
    const ms = addBusinessSeconds(schedule, createdMs, minutes * 60);
    return ms === null ? null : new Date(ms);
  };
  const startsAt = addBusinessSeconds(schedule, createdMs, 1);
  return {
    priority,
    timezone: schedule.timezone,
    createdAt: new Date(createdMs),
    createdLocal: { weekday: 1, hh: "17", mm: "30" },
    firstResponseDue: due(policy.first_response_minutes),
    resolutionDue: due(policy.resolution_minutes),
    // Adding one second lands more than a second later when the schedule is closed.
    startedOutsideHours: startsAt !== null && startsAt - createdMs > 1000,
  };
}

function addDaysLocal(y: number, m: number, d: number, n: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** A schedule row as the business-time functions want it. */
export function toBusinessSchedule(s: Pick<SlaSchedule, "timezone" | "weekly" | "holidays">): BusinessSchedule {
  return {
    timezone: s.timezone,
    weekly: s.weekly,
    holidays: s.holidays.map((h) => h.holiday_date),
  };
}
