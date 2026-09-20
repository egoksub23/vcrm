// ============================================================
// /api/integrations/jira/users — who is who between Vircle and Jira.
//
//   GET   the workspace's members with their Jira match (or none)
//   PUT   { userId, jiraAccountId | null, displayName? }  pick or clear a match
//         jira.connect: anyone. jira.link: only your own row.
//   POST  { action: "auto_match" }  match unmapped members by email (only when
//         Jira itself shows the email). jira.connect.
//
// A member without a match still works: their comments go out with their name
// in the text, and assigning an issue to them is skipped.
// ============================================================

import { NextResponse } from "next/server";

import { requireAnyCapability } from "@/lib/auth/account";
import { ApiError, apiErrorResponse, loadJiraContext } from "@/lib/jira/http";
import { autoMatchMembers } from "@/lib/jira/users";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JIRA_ACCOUNT = /^[A-Za-z0-9:_-]{1,128}$/;

export async function GET(request: Request) {
  try {
    const ctx = await requireAnyCapability(["jira.connect", "jira.link"]);
    const j = await loadJiraContext(ctx, request, { requireActive: false });
    const [{ data: members }, mapped] = await Promise.all([
      j.db.from("profiles").select("user_id, full_name, email").eq("account_id", ctx.accountId).order("full_name"),
      j.store.listUserMap(ctx.accountId),
    ]);
    const byUser = new Map(mapped.map((m) => [m.user_id, m]));
    return NextResponse.json({
      canManageAll: ctx.capabilities.has("jira.connect"),
      members: ((members as { user_id: string; full_name: string | null; email: string | null }[] | null) ?? []).map((m) => {
        const hit = byUser.get(m.user_id);
        return {
          userId: m.user_id,
          name: m.full_name || m.email || "",
          email: m.email,
          match: hit ? { jiraAccountId: hit.jira_account_id, displayName: hit.jira_display_name, method: hit.method } : null,
        };
      }),
    });
  } catch (err) {
    return apiErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireAnyCapability(["jira.connect", "jira.link"]);
    const limit = checkRateLimit(`jira:usermap:${ctx.userId}`, { limit: 60, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as { userId?: unknown; jiraAccountId?: unknown; displayName?: unknown } | null;
    if (!body || typeof body.userId !== "string" || !UUID.test(body.userId)) throw new ApiError(400, "bad_request", "userId is required");
    if (body.userId !== ctx.userId && !ctx.capabilities.has("jira.connect")) {
      throw new ApiError(403, "forbidden", "You can only pick your own Jira user");
    }
    const j = await loadJiraContext(ctx, request, { requireActive: false });

    // The person must belong to this workspace.
    const { data: member } = await j.db.from("profiles").select("user_id").eq("user_id", body.userId).eq("account_id", ctx.accountId).maybeSingle();
    if (!member) throw new ApiError(404, "not_found", "Member not found");

    if (body.jiraAccountId === null) {
      await j.db.from("jira_user_map").delete().eq("account_id", ctx.accountId).eq("user_id", body.userId);
      return NextResponse.json({ ok: true, match: null });
    }
    if (typeof body.jiraAccountId !== "string" || !JIRA_ACCOUNT.test(body.jiraAccountId)) {
      throw new ApiError(400, "bad_request", "Pick a Jira user");
    }
    const displayName = typeof body.displayName === "string" ? body.displayName.slice(0, 120) : null;
    // One Jira account belongs to one member: free it from anyone else first.
    await j.db.from("jira_user_map").delete().eq("account_id", ctx.accountId).eq("jira_account_id", body.jiraAccountId).neq("user_id", body.userId);
    const { error } = await j.db.from("jira_user_map").upsert(
      { account_id: ctx.accountId, user_id: body.userId, jira_account_id: body.jiraAccountId, jira_display_name: displayName, method: "manual" },
      { onConflict: "account_id,user_id" },
    );
    if (error) throw new ApiError(500, "internal", "Could not save the match");
    return NextResponse.json({ ok: true, match: { jiraAccountId: body.jiraAccountId, displayName, method: "manual" } });
  } catch (err) {
    return apiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireAnyCapability(["jira.connect"]);
    const limit = checkRateLimit(`jira:automatch:${ctx.userId}`, { limit: 5, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
    if (body?.action !== "auto_match") throw new ApiError(400, "bad_request", "Unknown action");
    const j = await loadJiraContext(ctx, request);
    const result = await autoMatchMembers({ db: j.db, store: j.store, client: j.client, accountId: ctx.accountId });
    return NextResponse.json(result);
  } catch (err) {
    return apiErrorResponse(err);
  }
}
