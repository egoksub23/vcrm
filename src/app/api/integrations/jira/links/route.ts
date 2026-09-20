// ============================================================
// POST /api/integrations/jira/links — "Link existing issue".
//
//   { ticketId, reference }   reference = a key (ENG-482) or an issue URL
//
// Reads the issue once, stores the link by its PERMANENT id, adds the
// "Vircle ticket" back link in Jira and records the existing comments as
// seen. At most five links per ticket; the project must be allowed. Needs
// jira.link.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability } from "@/lib/auth/account";
import { ApiError, apiErrorResponse, loadJiraContext } from "@/lib/jira/http";
import { linkExistingIssue } from "@/lib/jira/links";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("jira.link");
    const limit = checkRateLimit(`jira:link:${ctx.userId}`, { limit: 30, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as { ticketId?: unknown; reference?: unknown } | null;
    if (!body || typeof body.ticketId !== "string" || !UUID.test(body.ticketId)) throw new ApiError(400, "bad_request", "ticketId is required");
    if (typeof body.reference !== "string" || !body.reference.trim() || body.reference.length > 500) {
      throw new ApiError(400, "bad_request", "Paste an issue key or link");
    }

    const j = await loadJiraContext(ctx, request);
    const { data: visible } = await ctx.supabase.from("tickets").select("id").eq("id", body.ticketId).maybeSingle();
    if (!visible) throw new ApiError(404, "not_found", "Ticket not found");

    const link = await linkExistingIssue(j.sync, { ticketId: body.ticketId, reference: body.reference, userId: ctx.userId });
    return NextResponse.json({ link }, { status: 201 });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
