// ============================================================
// Compliance requests: the scheduled work. Server only.
//
// The clock sweep (hourly, /api/compliance/clock-cron): for every open, unpaused case with a hard stop whose workspace has the `compliance` flag on, a
// case within 10 days, within 5 days of the stop or at it is alerted ONCE per threshold: the database function claims the case (clock_alert_level
// moves up so it never repeats), writes a `clock_alert` event and puts an in-app notification in front of the holders of compliance.approve and
// compliance.review. No email: Part B sends those. The thresholds are src/lib/compliance/clock.ts ALERT_THRESHOLDS (10, 5, 0).
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export interface SweepResult {
  alerted: number;
  notified: number;
}

export async function runClockSweep(admin: SupabaseClient, now: Date = new Date()): Promise<SweepResult> {
  const { data, error } = await admin.rpc("compliance_clock_alert_sweep", { p_now: now.toISOString() });
  if (error) throw new Error("compliance clock sweep failed");
  const d = (data ?? {}) as Partial<SweepResult>;
  return { alerted: Number(d.alerted ?? 0), notified: Number(d.notified ?? 0) };
}
