// ============================================================
// What a ticket's SLA looks like on screen (badge, details card, filters,
// sorting, grouping). Pure: works from the stored columns (migration 086)
// and a clock the caller passes in, so the countdown can recompute every
// 30 seconds in the browser without asking the server.
//
// Display state of one target, from the stored state and the stored times:
//   met / paused / none   as stored
//   running past its due time     breached (the sweep marks it a minute later;
//                                 the screen does not wait for it)
//   running past its at-risk time at_risk
//   running otherwise             on_track
// Remaining time is in BUSINESS time when the policy has a schedule (the
// caller passes it) and wall-clock time otherwise.
// ============================================================

import { businessSecondsBetween, type BusinessSchedule } from "./business-time";
import type { SlaOverallState, SlaTarget, SlaTargetState, TicketSlaFields } from "./types";

export type TargetDisplayState = "none" | "on_track" | "at_risk" | "breached" | "paused" | "met";

export interface TargetView {
  target: SlaTarget;
  stored: SlaTargetState;
  state: TargetDisplayState;
  dueAt: number | null;
  /** Seconds until due (positive) or past due (negative), in business time when a schedule applies. */
  remainingSeconds: number | null;
  /** True when remainingSeconds is business time. */
  business: boolean;
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
};

export function targetView(
  target: SlaTarget,
  stored: SlaTargetState | undefined,
  dueIso: string | null | undefined,
  riskIso: string | null | undefined,
  now: number,
  schedule: BusinessSchedule | null,
): TargetView {
  const state = stored ?? "none";
  const dueAt = ms(dueIso);
  const riskAt = ms(riskIso);
  const business = schedule !== null;
  if (state === "none" || dueAt === null) {
    return { target, stored: state, state: state === "met" ? "met" : state === "paused" ? "paused" : "none", dueAt, remainingSeconds: null, business };
  }
  if (state === "met") return { target, stored: state, state: "met", dueAt, remainingSeconds: null, business };
  if (state === "paused") return { target, stored: state, state: "paused", dueAt, remainingSeconds: null, business };

  let display: TargetDisplayState;
  if (state === "breached" || now > dueAt) display = "breached";
  else if (riskAt !== null && now >= riskAt) display = "at_risk";
  else display = "on_track";

  let remaining: number;
  if (now <= dueAt) {
    remaining = businessSecondsBetween(schedule, now, dueAt) ?? Math.floor((dueAt - now) / 1000);
  } else {
    remaining = -(businessSecondsBetween(schedule, dueAt, now) ?? Math.floor((now - dueAt) / 1000));
  }
  return { target, stored: state, state: display, dueAt, remainingSeconds: remaining, business };
}

export interface TicketSlaView {
  first: TargetView;
  resolution: TargetView;
  /** The target the badge talks about (the most urgent one), null when there is no SLA. */
  primary: TargetView | null;
  overall: SlaOverallState;
}

const RANK: Record<TargetDisplayState, number> = {
  breached: 5,
  at_risk: 4,
  on_track: 3,
  paused: 2,
  met: 1,
  none: 0,
};

/** Most urgent first; on equal state the earlier due time wins. */
function moreUrgent(a: TargetView, b: TargetView): TargetView {
  if (RANK[a.state] !== RANK[b.state]) return RANK[a.state] > RANK[b.state] ? a : b;
  if (a.dueAt !== null && b.dueAt !== null) return a.dueAt <= b.dueAt ? a : b;
  return a;
}

export function ticketSlaView(
  t: TicketSlaFields,
  now: number,
  schedule: BusinessSchedule | null,
): TicketSlaView {
  const first = targetView("first_response", t.sla_first_response_state, t.sla_first_response_due_at, t.sla_first_response_risk_at, now, schedule);
  const resolution = targetView("resolution", t.sla_resolution_state, t.sla_resolution_due_at, t.sla_resolution_risk_at, now, schedule);
  const primary = first.state === "none" && resolution.state === "none" ? null : moreUrgent(first, resolution);
  return { first, resolution, primary, overall: primary ? primary.state : "none" };
}

/** Whether the ticket has any SLA at all (the badge is hidden otherwise). */
export function hasSla(t: TicketSlaFields): boolean {
  return (t.sla_first_response_state ?? "none") !== "none" || (t.sla_resolution_state ?? "none") !== "none";
}

/** "2h 10m", "35m", "3d 4h", "under a minute" (the caller translates the last one). */
export interface DurationParts {
  days: number;
  hours: number;
  minutes: number;
  /** True when the duration is under one minute. */
  lessThanMinute: boolean;
}

export function durationParts(seconds: number): DurationParts {
  const total = Math.floor(Math.abs(seconds) / 60);
  return {
    days: Math.floor(total / 1440),
    hours: Math.floor((total % 1440) / 60),
    minutes: total % 60,
    lessThanMinute: total === 0,
  };
}

/** Compact English-neutral "2h 10m" (units are universal enough to keep out of i18n). */
export function formatDuration(seconds: number): string {
  const p = durationParts(seconds);
  if (p.lessThanMinute) return "<1m";
  if (p.days > 0) return p.hours > 0 ? `${p.days}d ${p.hours}h` : `${p.days}d`;
  if (p.hours > 0) return p.minutes > 0 ? `${p.hours}h ${p.minutes}m` : `${p.hours}h`;
  return `${p.minutes}m`;
}

// ---- Filters, sort, group --------------------------------------------------------------

export type SlaQuickFilter = "sla_at_risk" | "sla_breached";

export function matchesSlaChip(chip: SlaQuickFilter, t: TicketSlaFields, now: number): boolean {
  const view = ticketSlaView(t, now, null);
  const states = [view.first.state, view.resolution.state];
  return chip === "sla_at_risk" ? states.includes("at_risk") : states.includes("breached");
}

/** Sort key for "SLA": the earliest due time among running / at-risk / breached targets; null last. */
export function slaDueSortKey(t: TicketSlaFields, now: number): number | null {
  const view = ticketSlaView(t, now, null);
  const live = [view.first, view.resolution].filter(
    (v) => (v.state === "on_track" || v.state === "at_risk" || v.state === "breached") && v.dueAt !== null,
  );
  if (live.length === 0) return null;
  return Math.min(...live.map((v) => v.dueAt as number));
}

export const SLA_GROUP_ORDER: readonly SlaOverallState[] = [
  "breached",
  "at_risk",
  "on_track",
  "paused",
  "met",
  "none",
];

export function slaGroupKey(t: TicketSlaFields, now: number): SlaOverallState {
  return ticketSlaView(t, now, null).overall;
}
