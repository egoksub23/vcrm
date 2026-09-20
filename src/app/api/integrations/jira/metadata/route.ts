// ============================================================
// GET /api/integrations/jira/metadata?kind=...
//
// Live Jira lookups for the dialogs and the settings screens. Needs
// jira.link. The result is only what a picker needs (ids and names).
//
//   kind=projects                 q (optional); all=1 (jira.connect holders
//                                 only) ignores the "allowed projects" list
//   kind=issue_types&project=KEY  the issue types a ticket can create there
//   kind=priorities               the site's priorities
//   kind=statuses&project=KEY     the statuses per issue type of a project
//
// Nothing here writes to Jira.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability } from "@/lib/auth/account";
import { ApiError, apiErrorResponse, loadJiraContext } from "@/lib/jira/http";
import { isProjectKey } from "@/lib/jira/settings";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

export async function GET(request: Request) {
  try {
    const ctx = await requireCapability("jira.link");
    const limit = checkRateLimit(`jira:meta:${ctx.userId}`, { limit: 60, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);

    const q = new URL(request.url).searchParams;
    const kind = q.get("kind");
    const j = await loadJiraContext(ctx, request);
    const project = q.get("project");
    if (project !== null && !isProjectKey(project)) throw new ApiError(400, "bad_request", "Invalid project");

    switch (kind) {
      case "projects": {
        const res = await j.client.listProjects({ query: (q.get("q") ?? "").slice(0, 100) || undefined, maxResults: 50 });
        const allowed = j.sync.settings.projects.allowed;
        const everything = q.get("all") === "1" && ctx.capabilities.has("jira.connect");
        const values = (res?.values ?? [])
          .filter((p) => everything || allowed.length === 0 || allowed.includes(p.key.toUpperCase()))
          .map((p) => ({ id: p.id, key: p.key, name: p.name }));
        // hasMore: Jira has more projects than this one page (a picker should offer typing a key).
        return NextResponse.json({ projects: values, hasMore: res?.isLast === false });
      }
      case "issue_types": {
        if (!project) throw new ApiError(400, "bad_request", "project is required");
        const res = await j.client.listCreateIssueTypes(project);
        const types = (res?.issueTypes ?? res?.values ?? []).filter((t) => !t.subtask).map((t) => ({ id: t.id, name: t.name }));
        return NextResponse.json({ issueTypes: types });
      }
      case "priorities": {
        const res = await j.client.listPriorities();
        return NextResponse.json({ priorities: (res?.values ?? []).map((p) => ({ id: p.id, name: p.name })) });
      }
      case "statuses": {
        if (!project) throw new ApiError(400, "bad_request", "project is required");
        const res = await j.client.listProjectStatuses(project);
        const byName = new Map<string, { id: string; name: string; category: string | null }>();
        for (const t of res ?? []) {
          for (const s of t.statuses ?? []) if (!byName.has(s.name)) byName.set(s.name, { id: s.id, name: s.name, category: s.statusCategory?.key ?? null });
        }
        return NextResponse.json({ statuses: [...byName.values()] });
      }
      default:
        throw new ApiError(400, "bad_request", "Unknown kind");
    }
  } catch (err) {
    return apiErrorResponse(err);
  }
}
