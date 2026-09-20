// A one-line reading of a weekly schedule for the list: consecutive days with
// the same hours are grouped ("Mon-Fri 09:00-18:00"). Pure.

import { ISO_WEEKDAYS, type IsoWeekday, type WeeklyHours } from "./business-time";

export interface HoursGroup {
  /** First and last ISO weekday of the run (equal for a single day). */
  from: IsoWeekday;
  to: IsoWeekday;
  /** "09:00-12:00, 13:00-17:00". */
  hours: string;
}

export function slotsText(weekly: WeeklyHours, day: IsoWeekday): string {
  return (weekly[String(day)] ?? []).map((s) => `${s.start}-${s.end}`).join(", ");
}

/** Runs of consecutive open days that share the same hours, in weekday order. */
export function summarizeWeekly(weekly: WeeklyHours): HoursGroup[] {
  const groups: HoursGroup[] = [];
  for (const day of ISO_WEEKDAYS) {
    const hours = slotsText(weekly, day);
    if (!hours) continue;
    const last = groups[groups.length - 1];
    if (last && last.hours === hours && last.to === day - 1) last.to = day;
    else groups.push({ from: day, to: day, hours });
  }
  return groups;
}
