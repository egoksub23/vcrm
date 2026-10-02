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

import { CRON_INTERVALS, cronRoute } from "@/lib/cron/guard";
import { runCron } from "@/lib/jira/cron";
import { jiraAppUrl } from "@/lib/jira/http";
import { isJiraConfigured } from "@/lib/jira/oauth";
import { cronDeps } from "@/lib/jira/service";

export const GET = cronRoute("jira", CRON_INTERVALS.jira, async (request) => {
  if (!isJiraConfigured()) return { body: { skipped: "jira not configured" } };

  const report = await runCron(cronDeps(jiraAppUrl(request)));
  return { body: report as unknown as Record<string, unknown> };
});
