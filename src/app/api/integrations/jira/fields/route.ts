// ============================================================
// GET /api/integrations/jira/fields?project=KEY[&issueType=ID][&refresh=1]
//
// The Fields tab's data (Settings > Integrations > Jira > Fields):
//   fields         the Jira fields of that project and issue type, classified:
//                  supported ones can be mapped, the rest come back with
//                  supported:false and a reason ("not supported")
//   issueTypes     the project's issue types (the chosen one first)
//   issueType      the one the fields are for (the project's default, else the first)
//   ticketFields   the ticket custom fields (migration 066) that can be mapped
//   mappings       this project's mappings and the "*" (every project) ones
//   cachedAt       when Jira was last asked (cached 24 h; refresh=1 asks again)
//
// Needs jira.connect. Nothing here writes to Jira.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability } from "@/lib/auth/account";
import { getFieldMeta } from "@/lib/jira/field-meta";
import { ApiError, apiErrorResponse, loadJiraContext } from "@/lib/jira/http";
import { effectiveSettings, isProjectKey } from "@/lib/jira/settings";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

export async function GET(request: Request) {
  try {
    const ctx = await requireCapability("jira.connect");
    const limit = checkRateLimit(`jira:fields:${ctx.userId}`, { limit: 40, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);

    const q = new URL(request.url).searchParams;
    const project = q.get("project");
    if (!isProjectKey(project)) throw new ApiError(400, "bad_request", "Choose a project");
    const projectKey = project.toUpperCase();
    const issueTypeParam = q.get("issueType");
    if (issueTypeParam !== null && !/^\d{1,20}$/.test(issueTypeParam)) throw new ApiError(400, "bad_request", "Invalid issue type");

    const j = await loadJiraContext(ctx, request);
    const allowed = j.sync.settings.projects.allowed;
    if (allowed.length > 0 && !allowed.includes(projectKey)) throw new ApiError(403, "project_not_allowed", "That project is not allowed");

    const typesRes = await j.client.listCreateIssueTypes(projectKey);
    const types = (typesRes?.issueTypes ?? typesRes?.values ?? []).filter((t) => !t.subtask).map((t) => ({ id: t.id, name: t.name }));
    if (types.length === 0) throw new ApiError(404, "not_found", "That project has no issue types");
    const wantedName = effectiveSettings(j.sync.settings, projectKey).projects.default_issue_type;
    const chosen =
      types.find((t) => t.id === issueTypeParam) ?? types.find((t) => wantedName && t.name.toLowerCase() === wantedName.toLowerCase()) ?? types[0];

    const meta = await getFieldMeta({
      db: j.db,
      client: j.client,
      connectionId: j.connection.id,
      accountId: j.connection.account_id,
      projectKey,
      issueTypeId: chosen.id,
      refresh: q.get("refresh") === "1",
    });

    const [defs, mappings] = await Promise.all([j.store.getFieldDefinitions(ctx.accountId), j.store.listFieldMappings(j.connection.id)]);
    return NextResponse.json({
      project: projectKey,
      issueType: chosen,
      issueTypes: types,
      fields: meta.fields,
      cachedAt: meta.fetchedAt,
      cached: meta.cached,
      ticketFields: defs.filter((d) => d.is_active !== false).map((d) => ({ id: d.id, label: d.label, field_type: d.field_type, options: d.options })),
      mappings: mappings.filter((m) => m.project_key === projectKey || m.project_key === "*"),
    });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
