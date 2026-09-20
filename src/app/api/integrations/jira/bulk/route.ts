// ============================================================
// /api/integrations/jira/bulk — bulk actions from the tickets list.
//
//   POST { action: "review", ticketIds, projectKey?, issueTypeId? }
//          -> { project, issueType, issueTypes, proposals: [...] }
//          Nothing is written: each ticket's proposed project / type /
//          summary, and which ones cannot be created and why.
//   POST { action: "create", items: [{ ticketId, projectKey, issueTypeId,
//          issueTypeName? }] }        -> 202 { batchId, total }
//   POST { action: "link", ticketIds, reference }   (ONE issue for all)
//                                     -> 202 { batchId, total, issueKey }
//   GET  ?batch=<id>                  -> progress: counts, per-ticket results
//
// At most 25 tickets per action. The work is queued (jira_sync_jobs, kind
// bulk_item) and runs through the same create / link code as the single
// buttons, respecting the per-connection concurrency and the shared-pool
// brake; the cron picks up whatever this request's own run does not finish.
// Needs jira.link. Max 5 links per ticket still applies.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability } from "@/lib/auth/account";
import { bulkProgress, MAX_BULK_TICKETS, reviewBulkCreate, startBulkCreate, startBulkLink } from "@/lib/jira/bulk";
import { runJobs } from "@/lib/jira/cron";
import { ApiError, apiErrorResponse, jiraAppUrl, loadJiraContext } from "@/lib/jira/http";
import { cronDeps } from "@/lib/jira/service";
import { effectiveSettings, isProjectKey } from "@/lib/jira/settings";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ticketIds(v: unknown): string[] {
  if (!Array.isArray(v)) throw new ApiError(400, "bad_request", "ticketIds is required");
  const ids = [...new Set(v.filter((x): x is string => typeof x === "string" && UUID.test(x)))];
  if (ids.length === 0) throw new ApiError(400, "bad_request", "Choose at least one ticket");
  if (ids.length > MAX_BULK_TICKETS) throw new ApiError(422, "bulk_limit", `At most ${MAX_BULK_TICKETS} tickets at a time`, { detail: { max: MAX_BULK_TICKETS } });
  return ids;
}

export async function GET(request: Request) {
  try {
    const ctx = await requireCapability("jira.link");
    const batch = new URL(request.url).searchParams.get("batch");
    if (!batch || !UUID.test(batch)) throw new ApiError(400, "bad_request", "Invalid batch");
    const j = await loadJiraContext(ctx, request, { requireActive: false });
    const progress = await bulkProgress(j.sync, batch);
    if (!progress) throw new ApiError(404, "not_found", "Batch not found");
    return NextResponse.json(progress);
  } catch (err) {
    return apiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("jira.link");
    const limit = checkRateLimit(`jira:bulk:${ctx.userId}`, { limit: 12, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw new ApiError(400, "bad_request", "Send { action, ... }");
    const j = await loadJiraContext(ctx, request);

    // The caller must be able to see every ticket (RLS on their own session).
    const assertVisible = async (ids: string[]) => {
      const { data } = await ctx.supabase.from("tickets").select("id").in("id", ids);
      if (((data as { id: string }[] | null) ?? []).length !== ids.length) throw new ApiError(404, "not_found", "Ticket not found");
    };

    if (body.action === "review") {
      const ids = ticketIds(body.ticketIds);
      await assertVisible(ids);
      const settings = j.sync.settings;
      const projectKey = isProjectKey(body.projectKey) ? body.projectKey.toUpperCase() : settings.projects.default_project;
      if (!projectKey) throw new ApiError(400, "bad_request", "Choose a project");
      if (settings.projects.allowed.length > 0 && !settings.projects.allowed.includes(projectKey)) {
        throw new ApiError(403, "project_not_allowed", "That project is not allowed");
      }
      const typesRes = await j.client.listCreateIssueTypes(projectKey);
      const types = (typesRes?.issueTypes ?? typesRes?.values ?? []).filter((t) => !t.subtask).map((t) => ({ id: t.id, name: t.name }));
      if (types.length === 0) throw new ApiError(404, "not_found", "That project has no issue types");
      // The project's own default issue type wins over the workspace's (per-project overrides).
      const wanted = effectiveSettings(settings, projectKey).projects.default_issue_type;
      const chosen =
        types.find((t) => typeof body.issueTypeId === "string" && t.id === body.issueTypeId) ??
        types.find((t) => wanted && t.name.toLowerCase() === wanted.toLowerCase()) ??
        types[0];
      const proposals = await reviewBulkCreate(j.sync, {
        ticketIds: ids,
        choices: { projectKey, issueTypeId: chosen.id, issueTypeName: chosen.name },
      });
      return NextResponse.json({ project: projectKey, issueType: chosen, issueTypes: types, proposals });
    }

    let started: { batchId: string; total: number; issueKey?: string };
    if (body.action === "create") {
      const raw = Array.isArray(body.items) ? body.items : [];
      const items = raw.flatMap((r) => {
        const o = (typeof r === "object" && r !== null ? r : {}) as Record<string, unknown>;
        if (typeof o.ticketId !== "string" || !UUID.test(o.ticketId) || !isProjectKey(o.projectKey)) return [];
        if (typeof o.issueTypeId !== "string" || !/^\d{1,20}$/.test(o.issueTypeId)) return [];
        return [
          {
            ticketId: o.ticketId,
            projectKey: o.projectKey.toUpperCase(),
            issueTypeId: o.issueTypeId,
            issueTypeName: typeof o.issueTypeName === "string" ? o.issueTypeName.slice(0, 80) : null,
            summary: typeof o.summary === "string" ? o.summary.slice(0, 255) : null,
          },
        ];
      });
      if (items.length === 0) throw new ApiError(400, "bad_request", "Choose at least one ticket");
      await assertVisible([...new Set(items.map((i) => i.ticketId))]);
      started = await startBulkCreate(j.sync, { items, userId: ctx.userId });
    } else if (body.action === "link") {
      const ids = ticketIds(body.ticketIds);
      if (typeof body.reference !== "string" || !body.reference.trim() || body.reference.length > 500) throw new ApiError(400, "bad_request", "Paste an issue key or link");
      await assertVisible(ids);
      started = await startBulkLink(j.sync, { ticketIds: ids, reference: body.reference, userId: ctx.userId });
    } else {
      throw new ApiError(400, "bad_request", "Unknown action");
    }

    // Start working straight away so the progress moves; the cron finishes anything left.
    void runJobs(cronDeps(jiraAppUrl(request), j.db), Date.now() + 45_000).catch(() => undefined);
    return NextResponse.json(started, { status: 202 });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
