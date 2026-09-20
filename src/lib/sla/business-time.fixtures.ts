// ============================================================
// Parity fixtures for the business-hours arithmetic.
//
// The SAME cases, with the SAME expected answers, are asserted twice:
//   - here in TypeScript (business-time.test.ts), and
//   - in SQL by supabase/ci/verify-086-ticket-sla.sql (section "parity"),
//     against sla_add_business_minutes / sla_business_minutes_between.
// If you change a case, change both files in the same commit. Instants are
// UTC; every expected value was checked by hand against the schedule.
// ============================================================

import type { BusinessSchedule, Slot } from "./business-time";

const day = (start: string, end: string): Slot[] => [{ start, end }];
const workdays = (slots: Slot[]) => ({ "1": slots, "2": slots, "3": slots, "4": slots, "5": slots, "6": [], "7": [] });
const everyday = (slots: Slot[]) => ({ "1": slots, "2": slots, "3": slots, "4": slots, "5": slots, "6": slots, "7": slots });

export const FIXTURE_SCHEDULES: Record<string, BusinessSchedule> = {
  // Mon-Fri 09:00-18:00, New York, Labor Day (Mon 2026-09-07) closed.
  NY: { timezone: "America/New_York", weekly: workdays(day("09:00", "18:00")), holidays: ["2026-09-07"] },
  // Two slots a day (lunch break), a zone without DST.
  KL: {
    timezone: "Asia/Kuala_Lumpur",
    weekly: workdays([
      { start: "09:00", end: "12:00" },
      { start: "13:00", end: "17:00" },
    ]),
    holidays: [],
  },
  // A night shift, every day 00:00-04:00: makes DST changes visible.
  NIGHT_NY: { timezone: "America/New_York", weekly: everyday(day("00:00", "04:00")), holidays: [] },
  NIGHT_SYD: { timezone: "Australia/Sydney", weekly: everyday(day("00:00", "04:00")), holidays: [] },
};

export interface AddCase {
  name: string;
  /** Key of FIXTURE_SCHEDULES, or null for 24/7. */
  schedule: string | null;
  from: string;
  minutes: number;
  /** ISO instant (UTC), or null when the cap is hit. */
  expected: string | null;
}

export const ADD_CASES: AddCase[] = [
  { name: "normal day, spills into the next morning", schedule: "NY", from: "2026-09-14T21:30:00Z", minutes: 45, expected: "2026-09-15T13:15:00Z" },
  { name: "starts after hours, waits for Monday", schedule: "NY", from: "2026-09-12T00:00:00Z", minutes: 60, expected: "2026-09-14T14:00:00Z" },
  { name: "starts on a Saturday", schedule: "NY", from: "2026-09-12T15:00:00Z", minutes: 30, expected: "2026-09-14T13:30:00Z" },
  { name: "skips a holiday Monday", schedule: "NY", from: "2026-09-04T21:00:00Z", minutes: 120, expected: "2026-09-08T14:00:00Z" },
  { name: "ends exactly at closing time", schedule: "NY", from: "2026-09-14T20:00:00Z", minutes: 120, expected: "2026-09-14T22:00:00Z" },
  { name: "starts exactly at closing time", schedule: "NY", from: "2026-09-14T22:00:00Z", minutes: 30, expected: "2026-09-15T13:30:00Z" },
  { name: "starts exactly at opening time", schedule: "NY", from: "2026-09-15T13:00:00Z", minutes: 30, expected: "2026-09-15T13:30:00Z" },
  { name: "zero minutes outside hours changes nothing", schedule: "NY", from: "2026-09-12T15:00:00Z", minutes: 0, expected: "2026-09-12T15:00:00Z" },
  { name: "thirty business days (six weeks)", schedule: "NY", from: "2026-09-14T13:00:00Z", minutes: 16200, expected: "2026-10-23T22:00:00Z" },
  { name: "beyond the 366 day cap gives NULL", schedule: "NY", from: "2026-09-14T13:00:00Z", minutes: 300000, expected: null },
  { name: "no schedule is 24/7", schedule: null, from: "2026-09-14T21:30:00Z", minutes: 90, expected: "2026-09-14T23:00:00Z" },
  { name: "two slots, lunch break in between (no DST zone)", schedule: "KL", from: "2026-09-15T03:30:00Z", minutes: 120, expected: "2026-09-15T06:30:00Z" },
  { name: "Friday evening in Kuala Lumpur waits for Monday", schedule: "KL", from: "2026-09-18T10:00:00Z", minutes: 30, expected: "2026-09-21T01:30:00Z" },
  { name: "DST spring forward, New York (3 real hours in the slot)", schedule: "NIGHT_NY", from: "2026-03-08T05:30:00Z", minutes: 180, expected: "2026-03-09T04:30:00Z" },
  { name: "DST fall back, New York (5 real hours in the slot)", schedule: "NIGHT_NY", from: "2026-11-01T04:30:00Z", minutes: 240, expected: "2026-11-01T08:30:00Z" },
  { name: "DST spring forward, Sydney (southern hemisphere)", schedule: "NIGHT_SYD", from: "2026-10-03T14:30:00Z", minutes: 180, expected: "2026-10-04T13:30:00Z" },
  { name: "DST fall back, Sydney (southern hemisphere)", schedule: "NIGHT_SYD", from: "2026-04-04T13:30:00Z", minutes: 240, expected: "2026-04-04T17:30:00Z" },
];

export interface BetweenCase {
  name: string;
  schedule: string | null;
  from: string;
  to: string;
  /** Whole business minutes, or null past the cap. */
  expected: number | null;
}

export const BETWEEN_CASES: BetweenCase[] = [
  { name: "across the evening", schedule: "NY", from: "2026-09-14T21:30:00Z", to: "2026-09-15T13:15:00Z", expected: 45 },
  { name: "across a weekend-free holiday Monday", schedule: "NY", from: "2026-09-04T16:00:00Z", to: "2026-09-08T16:00:00Z", expected: 540 },
  { name: "Sydney spring forward night", schedule: "NIGHT_SYD", from: "2026-10-03T14:00:00Z", to: "2026-10-04T14:00:00Z", expected: 240 },
  { name: "New York spring forward night", schedule: "NIGHT_NY", from: "2026-03-08T00:00:00Z", to: "2026-03-09T00:00:00Z", expected: 180 },
  { name: "reversed range is zero", schedule: "NY", from: "2026-09-15T13:15:00Z", to: "2026-09-14T21:30:00Z", expected: 0 },
  { name: "more than a year is NULL", schedule: "NY", from: "2026-01-01T00:00:00Z", to: "2027-03-01T00:00:00Z", expected: null },
  { name: "no schedule is wall time", schedule: null, from: "2026-09-14T21:30:00Z", to: "2026-09-14T23:00:00Z", expected: 90 },
];
