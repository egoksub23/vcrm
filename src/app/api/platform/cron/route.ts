// ============================================================
// GET /api/platform/cron — when did each scheduled job last run?
//
// Every job records a heartbeat (src/lib/cron/guard.ts, migration 135).
// This returns the full list of jobs the app expects, each with its last
// run, so a job that has never run or has gone quiet (a missing crontab
// line on the server) shows up instead of being silently absent.
//
// Operator only (requirePlatformAdmin); platform_cron_status() re-checks.
// ============================================================
import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { CRON_INTERVALS } from "@/lib/cron/guard";
import type { CronJobStatus } from "@/lib/cron/status";
import { requirePlatformAdmin } from "@/lib/platform/auth";

type Heartbeat = Omit<CronJobStatus, "job"> & { job: string };

export async function GET() {
  try {
    const ctx = await requirePlatformAdmin();
    const { data, error } = await ctx.supabase.rpc("platform_cron_status");
    if (error) {
      console.error("[GET /api/platform/cron] rpc error:", error);
      return NextResponse.json({ error: "Failed to load job status" }, { status: 500 });
    }

    const seen = new Map(((data ?? []) as Heartbeat[]).map((h) => [h.job, h]));
    const jobs: CronJobStatus[] = Object.entries(CRON_INTERVALS).map(([job, expected]) => {
      const h = seen.get(job);
      return h
        ? { ...h, expected_seconds: expected }
        : {
            job,
            expected_seconds: expected,
            last_run_at: null,
            last_ok_at: null,
            last_status: null,
            last_duration_ms: null,
            last_result: null,
            late: true,
          };
    });

    return NextResponse.json({ jobs }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
