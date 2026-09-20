// ============================================================
// GET /api/integrations/jira/issues/search?q=text-or-key
//
// The "Link existing issue" search. Needs jira.link. One JQL search
// (POST /search/jql), text and key only, limited to the allowed projects
// when the admin set some (see src/lib/jira/search.ts for the escaping).
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability } from "@/lib/auth/account";
import { apiErrorResponse, loadJiraContext } from "@/lib/jira/http";
import { buildSearchJql } from "@/lib/jira/search";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

export async function GET(request: Request) {
  try {
    const ctx = await requireCapability("jira.link");
    const limit = checkRateLimit(`jira:search:${ctx.userId}`, { limit: 40, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);

    const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
    const j = await loadJiraContext(ctx, request);
    const res = await j.client.searchIssues({
      jql: buildSearchJql(q, j.sync.settings.projects.allowed),
      fields: ["summary", "status", "issuetype", "project"],
      maxResults: 20,
    });
    return NextResponse.json({
      issues: (res?.issues ?? []).map((i) => ({
        id: i.id,
        key: i.key,
        summary: i.fields.summary ?? "",
        status: i.fields.status?.name ?? null,
        category: i.fields.status?.statusCategory?.key ?? null,
        project: i.fields.project?.key ?? null,
        type: i.fields.issuetype?.name ?? null,
      })),
    });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
