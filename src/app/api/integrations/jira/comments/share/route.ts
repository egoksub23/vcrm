// ============================================================
// POST /api/integrations/jira/comments/share   { noteId, linkId? }
//
// "Share with Jira" on an internal note: posted to every linked issue (or
// one) as "Name (Vircle): text", with a marker property, and the Jira
// comment id recorded straight away so the webhook announcing it is ignored.
// Only notes written in Vircle by a person are shareable; a note that came
// from Jira never goes back. Customer-facing messages are never sent (they
// are not notes). Needs jira.share-comments. A temporary Jira problem
// queues the post instead of failing.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability } from "@/lib/auth/account";
import { ApiError, apiErrorResponse, loadJiraContext } from "@/lib/jira/http";
import { shareNoteToJira, type ShareResult } from "@/lib/jira/sync";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("jira.share-comments");
    const limit = checkRateLimit(`jira:share:${ctx.userId}`, { limit: 30, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as { noteId?: unknown; linkId?: unknown } | null;
    if (!body || typeof body.noteId !== "string" || !UUID.test(body.noteId)) throw new ApiError(400, "bad_request", "noteId is required");
    if (body.linkId !== undefined && (typeof body.linkId !== "string" || !UUID.test(body.linkId))) throw new ApiError(400, "bad_request", "Invalid link");

    const j = await loadJiraContext(ctx, request);
    // The note must be visible to the caller (their own session, RLS).
    const { data: note } = await ctx.supabase.from("ticket_comments").select("id, ticket_id").eq("id", body.noteId).maybeSingle();
    if (!note) throw new ApiError(404, "not_found", "Note not found");

    let results: ShareResult[];
    try {
      results = await shareNoteToJira(j.sync, { noteId: body.noteId, actorUserId: ctx.userId, linkId: body.linkId as string | undefined });
    } catch (e) {
      if ((e as { retryable?: boolean })?.retryable) {
        // Jira is busy or down: queue it, the cron retries with backoff.
        await j.store.enqueue({
          accountId: ctx.accountId,
          connectionId: j.connection.id,
          kind: "post_comment",
          payload: { note_id: body.noteId, actor: ctx.userId, ...(body.linkId ? { link_id: body.linkId } : {}) },
          dedupeKey: `post:${body.noteId}`,
        });
        return NextResponse.json({ queued: true }, { status: 202 });
      }
      throw e;
    }
    if (results.some((r) => r.code === "toggle_off")) throw new ApiError(409, "toggle_off", "Sharing comments with Jira is switched off");
    if (results.length === 0) throw new ApiError(409, "no_links", "This ticket has no active Jira link");
    if (results.every((r) => r.code === "not_shareable")) throw new ApiError(422, "not_shareable", "Only notes written in Vircle can be shared");
    return NextResponse.json({ results }, { status: results.every((r) => r.ok) ? 200 : 207 });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
