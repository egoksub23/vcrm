// ============================================================
// GET /api/integrations/jira/cron
//
// The Jira queue processor, called on a schedule by the operator (the VPS
// crontab; see docs/jira-setup.md). Same secret and header as
// /api/sla/cron and /api/automations/cron: AUTOMATION_CRON_SECRET in the
// x-cron-secret header, so there is one secret to provision.
//
// One call: run due jobs, the catch-up poll (about every 5 minutes per
// connection), the daily webhook renewal / token keep-alive and the weekly
// personal-data report. Each step is idempotent and bounded; call it every
// minute or two.
// ============================================================

import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { runCron } from "@/lib/jira/cron";
import { jiraAppUrl } from "@/lib/jira/http";
import { isJiraConfigured } from "@/lib/jira/oauth";
import { cronDeps } from "@/lib/jira/service";

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  const supplied = Buffer.from(request.headers.get("x-cron-secret") ?? "");
  const want = Buffer.from(expected);
  if (supplied.length !== want.length || !timingSafeEqual(supplied, want)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Jira switched off on this deployment: nothing to do, and not an error.
  if (!isJiraConfigured()) return NextResponse.json({ skipped: "jira not configured" });

  try {
    const report = await runCron(cronDeps(jiraAppUrl(request)));
    return NextResponse.json(report);
  } catch (err) {
    console.error("[jira cron] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "cron failed" }, { status: 500 });
  }
}
