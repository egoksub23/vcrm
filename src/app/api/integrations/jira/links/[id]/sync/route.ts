// ============================================================
// POST /api/integrations/jira/links/[id]/sync — "Sync now" / "Resync".
//
// Reads the issue (and its comments) from Jira now and refreshes the card.
// At most once per 30 seconds per link (Jira's quota is shared by every
// customer). Needs jira.link.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability } from "@/lib/auth/account";
import { ApiError, apiErrorResponse, loadJiraContext } from "@/lib/jira/http";
import { resyncLink } from "@/lib/jira/sync";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability("jira.link");
    const { id } = await params;
    if (!UUID.test(id)) throw new ApiError(400, "bad_request", "Invalid link");

    const j = await loadJiraContext(ctx, request);
    const result = await resyncLink(j.sync, id);
    if (result.tooSoonMs) {
      const retry = Math.ceil(result.tooSoonMs / 1000);
      return NextResponse.json(
        { error: "resync_too_soon", message: "Synced a moment ago", retry_after_seconds: retry },
        { status: 429, headers: { "Retry-After": String(retry) } },
      );
    }
    if (result.skipped === "no_links") throw new ApiError(404, "not_found", "Link not found");
    return NextResponse.json({ ok: true, broken: result.broken ?? null });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
