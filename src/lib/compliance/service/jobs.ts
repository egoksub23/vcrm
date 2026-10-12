// ============================================================
// Compliance requests: the scheduled work. Server only.
//
// The clock sweep (hourly, /api/compliance/clock-cron): for every open, unpaused case with a hard stop whose workspace has the `compliance` flag on, a
// case within 10 days, within 5 days of the stop or at it is alerted ONCE per threshold: the database function claims the case (clock_alert_level
// moves up so it never repeats), writes a `clock_alert` event and puts an in-app notification in front of the holders of compliance.approve and
// compliance.review. The thresholds are src/lib/compliance/clock.ts ALERT_THRESHOLDS (10, 5, 0).
//
// Part B (migration 184) adds two things to the same hourly run, after the sweep: the alerts' EMAILS (the sweep's 'clock_alert' event is the claim that
// nothing is alerted twice; each alert's email has its own once-only claim in compliance_notices, so a run that died halfway is finished by the next
// without repeating anyone), and the housekeeping of the parent form's emailed codes (a code is useless after 15 minutes; rows are removed after two days).
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export interface SweepResult {
  alerted: number;
  notified: number;
}

export interface CodePurgeResult {
  purged: number;
}

/** Remove the emailed codes of the public forms that are more than two days old (they hold only hashes, and are useless after fifteen minutes). */
export async function purgeOldCodes(admin: SupabaseClient, now: Date = new Date()): Promise<CodePurgeResult> {
  const cutoff = new Date(now.getTime() - 2 * 86_400_000).toISOString();
  const { data, error } = await admin.from("compliance_email_codes").delete().lt("created_at", cutoff).select("id");
  if (error) return { purged: 0 };
  return { purged: Array.isArray(data) ? data.length : 0 };
}

export async function runClockSweep(admin: SupabaseClient, now: Date = new Date()): Promise<SweepResult> {
  const { data, error } = await admin.rpc("compliance_clock_alert_sweep", { p_now: now.toISOString() });
  if (error) throw new Error("compliance clock sweep failed");
  const d = (data ?? {}) as Partial<SweepResult>;
  return { alerted: Number(d.alerted ?? 0), notified: Number(d.notified ?? 0) };
}
