// ============================================================
// POST /api/integrations/jira/attachments/send — "Send to Jira" on a ticket
// attachment.
//
//   { attachmentId, linkId? }   linkId = one linked issue; omitted = every
//                               healthy link of the ticket
//
// The file is read from Vircle's own bucket on the server (the row's storage
// path must be under account-<id>/tickets/; a URL is never followed), checked
// (size cap from the Jira site, 20 files per issue, type, duplicate) and
// posted to Jira. Needs jira.link and the "attachments" switch on
// (Settings > Integrations > Jira > Direction). 200 with { results }, or 207
// when some links refused.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability } from "@/lib/auth/account";
import { sendTicketAttachment } from "@/lib/jira/attachments";
import { ApiError, apiErrorResponse, loadJiraContext } from "@/lib/jira/http";
import { attachmentStorage } from "@/lib/jira/service";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("jira.link");
    const limit = checkRateLimit(`jira:attach:${ctx.userId}`, { limit: 30, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as { attachmentId?: unknown; linkId?: unknown } | null;
    if (!body || typeof body.attachmentId !== "string" || !UUID.test(body.attachmentId)) throw new ApiError(400, "bad_request", "attachmentId is required");
    if (body.linkId !== undefined && (typeof body.linkId !== "string" || !UUID.test(body.linkId))) throw new ApiError(400, "bad_request", "Invalid link");

    const j = await loadJiraContext(ctx, request);
    // The caller must be able to see the attachment (RLS on their own session).
    const { data: visible } = await ctx.supabase.from("ticket_attachments").select("id").eq("id", body.attachmentId).maybeSingle();
    if (!visible) throw new ApiError(404, "not_found", "Attachment not found");

    const results = await sendTicketAttachment(
      { store: j.store, client: j.client, storage: attachmentStorage(j.db), connection: j.connection, settings: j.sync.settings },
      { attachmentId: body.attachmentId, linkId: typeof body.linkId === "string" ? body.linkId : undefined },
    );
    const allOk = results.length > 0 && results.every((r) => r.ok);
    return NextResponse.json({ results }, { status: allOk ? 200 : 207 });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
