// ============================================================
// Compliance requests: the clock. Pure (no I/O, no Node imports), so the list, the detail, the sweep and the tests share one definition.
//
//   target   the practice target (a closure: 14 days from the request date). Past it the case is AMBER.
//   stop     the regulatory hard stop (a closure: 30 days). Within STOP_NEAR_DAYS of it the case is RED ("near stop"); alerts go out at 10 and 5
//            days before it and at the stop; past it the case is BREACHED (red).
//   pause    a deliberate, logged action of the Head of Compliance (where the type allows it). While paused the clock is FROZEN at the moment of the
//            pause; when it resumes the stored dates are moved later by the time paused, so they always hold the effective deadline (the database does
//            this: compliance_clock). This module therefore treats the stored dates as the effective ones and, while paused, evaluates at the pause.
//   done     a completed or closed case: the clock no longer matters, only how long it took.
//
// A day is 24 hours. "Days to stop" is rounded UP (4 hours left is "1 day"), "day N" counts the request day as day 1, as people say it.
// ============================================================

import { FINISHED_STATUSES, type RequestStatus } from "./types";

export const DAY_MS = 86_400_000;
/** Within this many days of the hard stop a case is "near stop" (red). */
export const STOP_NEAR_DAYS = 10;
/** The days before the hard stop at which an alert is raised, then the stop itself (0). */
export const ALERT_THRESHOLDS = [10, 5, 0] as const;

export type ClockState = "none" | "on_track" | "target_passed" | "near_stop" | "breached" | "paused" | "done";
/** How loud to be: words always accompany it (never colour alone). */
export type ClockLevel = "none" | "ok" | "amber" | "red" | "grey";

export interface ClockInput {
  status: RequestStatus | string;
  receivedAt: string;
  targetDays: number | null;
  hardStopDays: number | null;
  targetDueAt: string | null;
  hardStopAt: string | null;
  pausedAt: string | null;
  completedAt?: string | null;
  closedAt?: string | null;
}

export interface ClockView {
  state: ClockState;
  level: ClockLevel;
  /** 1 on the day the request arrived. Frozen at the pause, or at the finish. */
  dayNumber: number;
  targetDays: number | null;
  hardStopDays: number | null;
  /** Whole days to the target, rounded up; 0 or less once it is passed. Null: no target. */
  daysToTarget: number | null;
  /** Whole days to the hard stop, rounded up; 0 or less once it is reached. Null: no hard stop. */
  daysToStop: number | null;
  /** Days past the hard stop (0 when not breached). */
  daysOverStop: number;
  /** The alert level reached (0 none, 1 the 10-day, 2 the 5-day, 3 the stop). */
  alertLevel: 0 | 1 | 2 | 3;
  paused: boolean;
  /** How many whole days a finished case took (day number at the finish), else null. */
  tookDays: number | null;
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** The alert level for the time left to the hard stop (negative: past it). The database sweep uses the same cut-offs. */
export function alertLevelFor(remainingMs: number): 0 | 1 | 2 | 3 {
  if (remainingMs <= 0) return 3;
  if (remainingMs <= 5 * DAY_MS) return 2;
  if (remainingMs <= 10 * DAY_MS) return 1;
  return 0;
}

export function isFinished(status: string): boolean {
  return (FINISHED_STATUSES as readonly string[]).includes(status);
}

export function computeClock(c: ClockInput, nowMs: number): ClockView {
  const received = ms(c.receivedAt) ?? nowMs;
  const finished = isFinished(c.status);
  const pausedAt = ms(c.pausedAt);
  const finishAt = ms(c.completedAt ?? null) ?? ms(c.closedAt ?? null);
  // The moment the clock is read at: now, or the pause, or the finish.
  const asOf = finished ? (finishAt ?? nowMs) : pausedAt !== null ? pausedAt : nowMs;
  const target = ms(c.targetDueAt);
  const stop = ms(c.hardStopAt);

  const dayNumber = Math.max(1, Math.floor((asOf - received) / DAY_MS) + 1);
  const daysToTarget = target === null ? null : Math.ceil((target - asOf) / DAY_MS);
  const daysToStop = stop === null ? null : Math.ceil((stop - asOf) / DAY_MS);
  const remaining = stop === null ? Infinity : stop - asOf;
  const alertLevel = stop === null ? 0 : alertLevelFor(remaining);
  const base = {
    dayNumber,
    targetDays: c.targetDays,
    hardStopDays: c.hardStopDays,
    daysToTarget,
    daysToStop,
    daysOverStop: stop !== null && asOf >= stop ? Math.floor((asOf - stop) / DAY_MS) : 0,
    alertLevel,
    paused: !finished && pausedAt !== null,
    tookDays: finished ? dayNumber : null,
  };

  if (finished) return { ...base, state: "done", level: "grey", alertLevel: 0 };
  if (pausedAt !== null) return { ...base, state: "paused", level: "grey" };
  if (target === null && stop === null) return { ...base, state: "none", level: "none", alertLevel: 0 };
  if (stop !== null && remaining <= 0) return { ...base, state: "breached", level: "red" };
  if (stop !== null && remaining <= STOP_NEAR_DAYS * DAY_MS) return { ...base, state: "near_stop", level: "red" };
  if (target !== null && asOf >= target) return { ...base, state: "target_passed", level: "amber" };
  return { ...base, state: "on_track", level: "ok" };
}

/** The filters of the list, as bucket names. "all" is no filter. */
export const DUE_FILTERS = ["all", "on_track", "target_passed", "near_stop", "breached", "paused", "done"] as const;
export type DueFilter = (typeof DUE_FILTERS)[number];

/** Is a case in this bucket? (The list route filters in the database with the same cut-offs; this is the in-memory twin the counts and the tests use.) */
export function inDueBucket(c: ClockInput, bucket: DueFilter, nowMs: number): boolean {
  if (bucket === "all") return true;
  return computeClock(c, nowMs).state === bucket;
}
