// ============================================================
// GET /api/integrations/jira/users/search?q=&project=
//
// Jira users for a picker (the manual match, the assignee of a new issue).
// With `project`, only users who can be assigned there. Needs jira.link.
// Only active people are returned; an email is included only when Jira
// itself shows it.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability } from "@/lib/auth/account";
import { ApiError, apiErrorResponse, loadJiraContext } from "@/lib/jira/http";
import { isProjectKey } from "@/lib/jira/settings";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

export async function GET(request: Request) {
  try {
    const ctx = await requireCapability("jira.link");
    const limit = checkRateLimit(`jira:usersearch:${ctx.userId}`, { limit: 60, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);

    const q = new URL(request.url).searchParams;
    const query = (q.get("q") ?? "").trim().slice(0, 100);
    const project = q.get("project");
    if (project !== null && !isProjectKey(project)) throw new ApiError(400, "bad_request", "Invalid project");
    if (query.length < 2) return NextResponse.json({ users: [] });

    const j = await loadJiraContext(ctx, request);
    const found = project ? await j.client.assignableUsers(project, query) : await j.client.searchUsers(query);
    return NextResponse.json({
      users: (found ?? [])
        .filter((u) => u.active !== false)
        .map((u) => ({
          accountId: u.accountId,
          displayName: u.displayName ?? "",
          email: (u as { emailAddress?: string }).emailAddress ?? null,
        })),
    });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
