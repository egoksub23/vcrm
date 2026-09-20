// ============================================================
// /api/integrations/jira/field-mappings — custom-field mappings.
//
//   PUT     { projectKey, issueTypeId, ticketFieldId, jiraFieldId,
//             direction: to_jira|from_jira|both, whenMissing: skip|clear|default,
//             defaultValue?, label? }   save (insert or replace) one mapping
//   DELETE  ?id=<mapping id>            remove one
//
// projectKey is a project key or "*" (every project). The Jira field is
// checked against the create metadata of that project and issue type: a
// field of an unsupported type, or one that is not compatible with the ticket
// field's type, is refused (422 unsupported_field / incompatible_field).
// Needs jira.connect; every change is audited (names only).
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability } from "@/lib/auth/account";
import { getFieldMeta, MAX_MAPPINGS, saveMapping, validateMapping } from "@/lib/jira/field-meta";
import { ApiError, apiErrorResponse, loadJiraContext } from "@/lib/jira/http";
import { isProjectKey } from "@/lib/jira/settings";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REFUSAL_STATUS: Record<string, { code: string; message: string }> = {
  no_such_field: { code: "bad_request", message: "That ticket field does not exist" },
  no_such_jira_field: { code: "bad_request", message: "That Jira field is not on the create screen" },
  unsupported: { code: "unsupported_field", message: "Vircle cannot map that type of Jira field" },
  incompatible: { code: "incompatible_field", message: "Those two fields have different types" },
  bad_direction: { code: "bad_request", message: "Invalid direction or missing-value choice" },
};

export async function PUT(request: Request) {
  try {
    const ctx = await requireCapability("jira.connect");
    const limit = checkRateLimit(`jira:fieldmap:${ctx.userId}`, { limit: 40, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);

    const b = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b) throw new ApiError(400, "bad_request", "Send the mapping");
    const projectKey = b.projectKey === "*" ? "*" : isProjectKey(b.projectKey) ? b.projectKey.toUpperCase() : null;
    if (!projectKey) throw new ApiError(400, "bad_request", "Choose a project");
    if (typeof b.ticketFieldId !== "string" || !UUID.test(b.ticketFieldId)) throw new ApiError(400, "bad_request", "Choose a ticket field");
    if (typeof b.jiraFieldId !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(b.jiraFieldId)) throw new ApiError(400, "bad_request", "Choose a Jira field");
    if (typeof b.issueTypeId !== "string" || !/^\d{1,20}$/.test(b.issueTypeId)) throw new ApiError(400, "bad_request", "Choose an issue type");
    const direction = b.direction as "to_jira" | "from_jira" | "both";
    const whenMissing = b.whenMissing as "skip" | "clear" | "default";
    const defaultValue = typeof b.defaultValue === "string" && b.defaultValue.trim() ? b.defaultValue.trim() : null;
    const label = typeof b.label === "string" && b.label.trim() ? b.label.trim() : null;

    const j = await loadJiraContext(ctx, request);
    if (projectKey === "*") {
      // "Every project" is read from the workspace's default project's create screen.
      const dp = j.sync.settings.projects.default_project;
      if (!dp) throw new ApiError(400, "bad_request", "Choose a default project first, or map per project");
    } else {
      const allowed = j.sync.settings.projects.allowed;
      if (allowed.length > 0 && !allowed.includes(projectKey)) throw new ApiError(403, "project_not_allowed", "That project is not allowed");
    }
    const readFrom = projectKey === "*" ? (j.sync.settings.projects.default_project as string) : projectKey;

    const [defs, existing] = await Promise.all([j.store.getFieldDefinitions(ctx.accountId), j.store.listFieldMappings(j.connection.id)]);
    const def = defs.find((d) => d.id === b.ticketFieldId && d.is_active !== false);
    const meta = await getFieldMeta({
      db: j.db,
      client: j.client,
      connectionId: j.connection.id,
      accountId: j.connection.account_id,
      projectKey: readFrom,
      issueTypeId: b.issueTypeId,
    });
    const jira = meta.fields.find((f) => f.id === b.jiraFieldId);

    const refusal = validateMapping({ direction, whenMissing }, def, jira);
    if (refusal) {
      const r = REFUSAL_STATUS[refusal] ?? { code: "bad_request", message: refusal };
      throw new ApiError(r.code === "bad_request" ? 400 : 422, r.code, r.message);
    }
    const isNew = !existing.some((m) => m.project_key === projectKey && m.ticket_field_id === def!.id);
    if (isNew && existing.length >= MAX_MAPPINGS) throw new ApiError(422, "too_many", `At most ${MAX_MAPPINGS} field mappings`);

    const mapping = await saveMapping({
      db: j.db,
      connectionId: j.connection.id,
      accountId: j.connection.account_id,
      input: { projectKey, ticketFieldId: def!.id, jiraFieldId: jira!.id, direction, whenMissing, defaultValue, label },
      def: def!,
      jira: jira!,
    });
    await j.store.audit({
      accountId: ctx.accountId,
      actorId: ctx.userId,
      action: "updated",
      entityType: "jira_connection",
      entityId: j.connection.id,
      label: j.connection.site_name ?? "Jira",
      summary: { changed: ["field_mappings"], project: projectKey, ticket_field: def!.label, jira_field: jira!.name, direction },
    });
    return NextResponse.json({ mapping });
  } catch (err) {
    return apiErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireCapability("jira.connect");
    const limit = checkRateLimit(`jira:fieldmap:${ctx.userId}`, { limit: 40, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);

    const id = new URL(request.url).searchParams.get("id");
    if (!id || !UUID.test(id)) throw new ApiError(400, "bad_request", "Invalid mapping");
    const j = await loadJiraContext(ctx, request, { requireActive: false });
    const rows = await j.store.listFieldMappings(j.connection.id);
    const row = rows.find((m) => m.id === id);
    if (!row) throw new ApiError(404, "not_found", "Mapping not found");
    // Only our own database row: nothing in Jira is touched (the field keeps its value there).
    const { error } = await j.db.from("jira_field_mappings").delete().eq("id", id).eq("connection_id", j.connection.id);
    if (error) throw new Error(`Could not remove the mapping: ${error.message}`);
    await j.store.audit({
      accountId: ctx.accountId,
      actorId: ctx.userId,
      action: "updated",
      entityType: "jira_connection",
      entityId: j.connection.id,
      label: j.connection.site_name ?? "Jira",
      summary: { changed: ["field_mappings"], project: row.project_key, jira_field: row.jira_field_name, removed: true },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
