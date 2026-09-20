// ============================================================
// Business-hours arithmetic for ticket SLAs (migration 086).
//
// Pure, no I/O. This is the TypeScript mirror of the SQL functions
// `sla_add_business_seconds` / `sla_business_seconds_between` (and the
// minute wrappers `sla_add_business_minutes` / `sla_business_minutes_between`)
// in supabase/ci/drafts/086_ticket_sla.sql. The two must agree: the
// fixtures in `business-time.fixtures.ts` are asserted by the unit tests here
// AND by supabase/ci/verify-086-ticket-sla.sql.
//
// The model
//   - A schedule has an IANA timezone, a weekly pattern (ISO weekday 1..7,
//     each an array of {start:'HH:MM', end:'HH:MM'} slots) and a list of
//     holidays (whole local calendar days that are closed).
//   - A slot never crosses midnight (use two slots for an overnight shift).
//     The only way to reach midnight is end = "24:00".
//   - Business time only flows inside slots, [start, end): a slot's end
//     instant is not open, its start instant is.
//   - Slot boundaries are turned into real instants with the schedule's zone,
//     one local date at a time, so a day with a DST change measures the REAL
//     open time (a 01:00-04:00 slot is 2 hours on the spring-forward night).
//   - A local time that does not exist (spring forward) or exists twice (fall
//     back) resolves the way Postgres does: with the STANDARD offset (the
//     smaller one), never the DST one. See `zonedToInstant`.
//   - No schedule (null) means 24/7: business time is wall time.
//   - The loop walks at most MAX_SCHEDULE_DAYS local dates. Beyond that the
//     result is null (SQL: NULL plus a WARNING); it can never loop forever.
//   - Adding zero seconds returns the start unchanged (nothing to consume).
//     Adding a positive amount from outside opening hours starts counting at
//     the next opening.
// ============================================================

export const MAX_SCHEDULE_DAYS = 366;
export const MAX_SLOTS_PER_DAY = 4;

export interface Slot {
  /** "HH:MM", 00:00 - 23:59. */
  start: string;
  /** "HH:MM", 00:01 - 23:59, or "24:00" (midnight at the end of the day). */
  end: string;
}

export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const ISO_WEEKDAYS: readonly IsoWeekday[] = [1, 2, 3, 4, 5, 6, 7];

/** Keys "1".."7" (ISO: Monday = 1). A missing or empty day is closed. */
export type WeeklyHours = Partial<Record<string, Slot[]>>;

export interface BusinessSchedule {
  /** IANA name, e.g. "America/New_York". */
  timezone: string;
  weekly: WeeklyHours;
  /** Closed whole days, "YYYY-MM-DD" in the schedule's own zone. */
  holidays?: readonly string[];
}

// ---- Small helpers -----------------------------------------------------------

const MS_MIN = 60_000;
const MS_DAY = 86_400_000;

/** "HH:MM" to minutes since midnight; null when malformed. "24:00" is 1440. */
export function parseHm(value: unknown): number | null {
  if (typeof value !== "string") return null;
  if (value === "24:00") return 1440;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function formatHm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timezone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    dtfCache.set(timezone, f);
  }
  return f;
}

/** Whether Intl knows the zone (the UI uses this before the database does). */
export function isValidTimezone(timezone: string): boolean {
  if (typeof timezone !== "string" || timezone.trim() === "") return false;
  try {
    formatterFor(timezone);
    return true;
  } catch {
    return false;
  }
}

/** The zone's UTC offset in milliseconds at an instant (east of UTC is positive). */
function offsetAt(ms: number, timezone: string): number {
  const parts = formatterFor(timezone).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  // formatToParts drops sub-second precision, so compare against whole seconds.
  return asUtc - Math.floor(ms / 1000) * 1000;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  /** ISO weekday, Monday = 1 .. Sunday = 7. */
  weekday: IsoWeekday;
  /** Minutes since local midnight. */
  minutes: number;
}

/** The wall-clock reading in a zone at an instant. */
export function localParts(ms: number, timezone: string): LocalParts {
  const parts = formatterFor(timezone).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const weekday = isoWeekdayOf(year, month, day);
  return { year, month, day, weekday, minutes: get("hour") * 60 + get("minute") };
}

/** ISO weekday of a calendar date (timezone free). */
export function isoWeekdayOf(year: number, month: number, day: number): IsoWeekday {
  const js = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = Sunday
  return (js === 0 ? 7 : js) as IsoWeekday;
}

/**
 * The instant a wall-clock time in a zone happens, in milliseconds.
 * `minutes` may be 1440 ("24:00", i.e. next day 00:00).
 *
 * Gap (spring forward, the time does not exist) and overlap (fall back, it
 * happens twice) both resolve with the smaller of the two candidate offsets,
 * which is what Postgres does for `timestamp AT TIME ZONE zone`:
 *   America/New_York 2026-03-08 02:30 -> 07:30Z (03:30 EDT)
 *   America/New_York 2026-11-01 01:30 -> 06:30Z (the second, EST, 01:30)
 */
export function zonedToInstant(
  year: number,
  month: number,
  day: number,
  minutes: number,
  timezone: string,
): number {
  const localAsUtc = Date.UTC(year, month - 1, day) + minutes * MS_MIN;
  const before = offsetAt(localAsUtc - MS_DAY, timezone);
  const after = offsetAt(localAsUtc + MS_DAY, timezone);
  if (before === after) return localAsUtc - before;
  const candidates = [before, after].sort((a, b) => a - b);
  const consistent = candidates.filter((o) => offsetAt(localAsUtc - o, timezone) === o);
  const chosen = consistent.length === 1 ? consistent[0] : candidates[0];
  return localAsUtc - chosen;
}

// ---- Validation ---------------------------------------------------------------

export type WeeklyErrorCode =
  | "bad_day"
  | "too_many_slots"
  | "bad_time"
  | "end_before_start"
  | "overlap"
  | "no_open_day";

export interface WeeklyError {
  code: WeeklyErrorCode;
  /** ISO weekday the problem is on ("" for no_open_day). */
  day: string;
}

/**
 * Structural checks the database repeats in `sla_validate_weekly`: keys 1..7
 * only, at most 4 slots a day, times valid, end after start, slots in one day
 * never overlap, and at least one open day.
 */
export function validateWeekly(weekly: unknown): WeeklyError[] {
  const errors: WeeklyError[] = [];
  if (!weekly || typeof weekly !== "object" || Array.isArray(weekly)) {
    return [{ code: "bad_day", day: "" }];
  }
  let openDays = 0;
  for (const [day, value] of Object.entries(weekly as Record<string, unknown>)) {
    if (!/^[1-7]$/.test(day) || !Array.isArray(value)) {
      errors.push({ code: "bad_day", day });
      continue;
    }
    if (value.length > MAX_SLOTS_PER_DAY) errors.push({ code: "too_many_slots", day });
    const ranges: [number, number][] = [];
    for (const slot of value) {
      const s = parseHm((slot as Slot | null)?.start);
      const e = parseHm((slot as Slot | null)?.end);
      if (s === null || e === null || s >= 1440) {
        errors.push({ code: "bad_time", day });
        continue;
      }
      if (e <= s) {
        errors.push({ code: "end_before_start", day });
        continue;
      }
      ranges.push([s, e]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i][0] < ranges[i - 1][1]) {
        errors.push({ code: "overlap", day });
        break;
      }
    }
    if (value.length > 0) openDays += 1;
  }
  if (openDays === 0) errors.push({ code: "no_open_day", day: "" });
  return errors;
}

// ---- The arithmetic --------------------------------------------------------------

interface DayPlan {
  weekly: Map<IsoWeekday, [number, number][]>;
  holidays: Set<string>;
  timezone: string;
}

function planOf(schedule: BusinessSchedule): DayPlan {
  const weekly = new Map<IsoWeekday, [number, number][]>();
  for (const day of ISO_WEEKDAYS) {
    const slots = (schedule.weekly[String(day)] ?? [])
      .map((s) => [parseHm(s.start), parseHm(s.end)] as const)
      .filter((r): r is readonly [number, number] => r[0] !== null && r[1] !== null && r[1] > r[0])
      .map((r) => [r[0], r[1]] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    weekly.set(day, slots);
  }
  return { weekly, holidays: new Set(schedule.holidays ?? []), timezone: schedule.timezone };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const dateKey = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;

/** Advance a calendar date by n days (timezone free). */
function addDays(y: number, m: number, d: number, n: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/**
 * Walk the open intervals [S, E) (epoch ms) that end after `fromMs`, in order,
 * for at most MAX_SCHEDULE_DAYS local dates (and, with `untilMs`, no further
 * than the local date of that instant). `visit` returns true to stop. Returns
 * false when the loop hit the day cap first.
 */
function walkOpenIntervals(
  plan: DayPlan,
  fromMs: number,
  visit: (startMs: number, endMs: number) => boolean,
  untilMs?: number,
): boolean {
  const first = localParts(fromMs, plan.timezone);
  const lastDay = untilMs === undefined ? null : localParts(untilMs, plan.timezone);
  const lastDayNumber = lastDay ? Date.UTC(lastDay.year, lastDay.month - 1, lastDay.day) : null;
  for (let k = 0; k < MAX_SCHEDULE_DAYS; k++) {
    const { y, m, d } = addDays(first.year, first.month, first.day, k);
    // Past the local date of the end of the range: nothing more can count.
    if (lastDayNumber !== null && Date.UTC(y, m - 1, d) > lastDayNumber) return true;
    if (plan.holidays.has(dateKey(y, m, d))) continue;
    const weekday = isoWeekdayOf(y, m, d);
    for (const [startMin, endMin] of plan.weekly.get(weekday) ?? []) {
      const endMs = zonedToInstant(y, m, d, endMin, plan.timezone);
      if (endMs <= fromMs) continue;
      const startMs = zonedToInstant(y, m, d, startMin, plan.timezone);
      if (visit(startMs, endMs)) return true;
    }
  }
  return false;
}

/**
 * `seconds` of business time after `fromMs`, as an instant (ms). Null when the
 * schedule does not have enough open time within MAX_SCHEDULE_DAYS days.
 */
export function addBusinessSeconds(
  schedule: BusinessSchedule | null,
  fromMs: number,
  seconds: number,
): number | null {
  if (seconds < 0) return null;
  if (!schedule) return fromMs + seconds * 1000;
  if (seconds === 0) return fromMs;
  let remaining = seconds * 1000;
  let result: number | null = null;
  walkOpenIntervals(planOf(schedule), fromMs, (startMs, endMs) => {
    const s = Math.max(startMs, fromMs);
    const available = endMs - s;
    if (remaining <= available) {
      result = s + remaining;
      return true;
    }
    remaining -= available;
    return false;
  });
  return result;
}

/**
 * Business seconds between two instants (whole seconds, rounded down). Zero
 * when `toMs <= fromMs`. Null when the span reaches beyond MAX_SCHEDULE_DAYS
 * local dates.
 */
export function businessSecondsBetween(
  schedule: BusinessSchedule | null,
  fromMs: number,
  toMs: number,
): number | null {
  if (toMs <= fromMs) return 0;
  if (!schedule) return Math.floor((toMs - fromMs) / 1000);
  let total = 0;
  const finished = walkOpenIntervals(planOf(schedule), fromMs, (startMs, endMs) => {
    if (startMs >= toMs) return true;
    total += Math.min(endMs, toMs) - Math.max(startMs, fromMs);
    return endMs >= toMs;
  }, toMs);
  return finished ? Math.floor(total / 1000) : null;
}

/** `minutes` of business time after `from`. Null when it does not fit in the cap. */
export function addBusinessMinutes(
  schedule: BusinessSchedule | null,
  from: Date,
  minutes: number,
): Date | null {
  const r = addBusinessSeconds(schedule, from.getTime(), minutes * 60);
  return r === null ? null : new Date(r);
}

/** Whole business minutes between two instants (rounded down); null past the cap. */
export function businessMinutesBetween(
  schedule: BusinessSchedule | null,
  from: Date,
  to: Date,
): number | null {
  const s = businessSecondsBetween(schedule, from.getTime(), to.getTime());
  return s === null ? null : Math.floor(s / 60);
}

/** Whether a business schedule is open at an instant. Null schedule: always. */
export function isOpenAt(schedule: BusinessSchedule | null, ms: number): boolean {
  if (!schedule) return true;
  let open = false;
  walkOpenIntervals(planOf(schedule), ms, (startMs, endMs) => {
    open = startMs <= ms && ms < endMs;
    return true;
  });
  return open;
}

/** The earliest instant at or after `ms` when the schedule is open. */
export function nextOpening(schedule: BusinessSchedule | null, ms: number): number | null {
  if (!schedule) return ms;
  let result: number | null = null;
  walkOpenIntervals(planOf(schedule), ms, (startMs) => {
    result = Math.max(startMs, ms);
    return true;
  });
  return result;
}

// ---- Convenience for the policy screen and tests -----------------------------------

export const MON_FRI_9_TO_18: WeeklyHours = {
  "1": [{ start: "09:00", end: "18:00" }],
  "2": [{ start: "09:00", end: "18:00" }],
  "3": [{ start: "09:00", end: "18:00" }],
  "4": [{ start: "09:00", end: "18:00" }],
  "5": [{ start: "09:00", end: "18:00" }],
  "6": [],
  "7": [],
};

export function emptyWeekly(): WeeklyHours {
  return { "1": [], "2": [], "3": [], "4": [], "5": [], "6": [], "7": [] };
}

/** Minutes a target is worth expressed in the unit the form uses. */
export function splitMinutes(total: number): { value: number; unit: "minutes" | "hours" | "days" } {
  if (total > 0 && total % 1440 === 0) return { value: total / 1440, unit: "days" };
  if (total > 0 && total % 60 === 0) return { value: total / 60, unit: "hours" };
  return { value: total, unit: "minutes" };
}

export function toMinutes(value: number, unit: "minutes" | "hours" | "days"): number {
  return Math.round(value * (unit === "days" ? 1440 : unit === "hours" ? 60 : 1));
}
