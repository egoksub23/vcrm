// ============================================================
// GET /api/integrations/jira/links/[id]/transitions
//
// The transitions the linked issue offers right now, for "Move Jira issue
// to...". Only what Jira lists is ever shown. Needs jira.link.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability } from "@/lib/auth/account";
import { ApiError, apiErrorResponse, loadJiraContext } from "@/lib/jira/http";
import { listTransitions } from "@/lib/jira/links";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability("jira.link");
    const limit = checkRateLimit(`jira:transitions:${ctx.userId}`, { limit: 60, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await params;
    if (!UUID.test(id)) throw new ApiError(400, "bad_request", "Invalid link");
    const j = await loadJiraContext(ctx, request);
    return NextResponse.json({ transitions: await listTransitions(j.sync, id) });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
