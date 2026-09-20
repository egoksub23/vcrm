// ============================================================
// DELETE /api/integrations/jira/links/[id] — Unlink.
//
// Removes the link (and its comment map) in Vircle; nothing is deleted in
// Jira. Logged in the ticket history and the audit log. Needs jira.link.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability } from "@/lib/auth/account";
import { ApiError, apiErrorResponse, loadJiraContext } from "@/lib/jira/http";
import { unlinkIssue } from "@/lib/jira/links";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability("jira.link");
    const limit = checkRateLimit(`jira:unlink:${ctx.userId}`, { limit: 30, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!UUID.test(id)) throw new ApiError(400, "bad_request", "Invalid link");
    // Works while the connection is paused too: a broken link must always be removable.
    const j = await loadJiraContext(ctx, request, { requireActive: false });
    await unlinkIssue(j.sync, { linkId: id, userId: ctx.userId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
