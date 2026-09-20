// ============================================================
// POST /api/integrations/jira/links/[id]/transition   { transitionId }
//
// "Move Jira issue to...": ONE transition the issue currently offers, never
// a chain. Needs jira.link. If Jira says the connected user may not do it,
// the answer is a clear 403 message and nothing is retried.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability } from "@/lib/auth/account";
import { ApiError, apiErrorResponse, loadJiraContext } from "@/lib/jira/http";
import { transitionByHand } from "@/lib/jira/links";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability("jira.link");
    const limit = checkRateLimit(`jira:transition:${ctx.userId}`, { limit: 30, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await params;
    if (!UUID.test(id)) throw new ApiError(400, "bad_request", "Invalid link");
    const body = (await request.json().catch(() => null)) as { transitionId?: unknown } | null;
    if (!body || typeof body.transitionId !== "string" || !/^\d{1,10}$/.test(body.transitionId)) {
      throw new ApiError(400, "bad_request", "transitionId is required");
    }
    const j = await loadJiraContext(ctx, request);
    await transitionByHand(j.sync, { linkId: id, transitionId: body.transitionId, userId: ctx.userId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
