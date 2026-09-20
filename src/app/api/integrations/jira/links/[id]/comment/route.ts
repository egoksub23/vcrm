// ============================================================
// POST /api/integrations/jira/links/[id]/comment   { text }
//
// "Comment in Jira" from the card: the text becomes an internal note on the
// ticket (so the history stays in one place) and is shared to THIS issue as
// "Name (Vircle): text". Needs jira.share-comments.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability } from "@/lib/auth/account";
import { ApiError, apiErrorResponse, loadJiraContext } from "@/lib/jira/http";
import { shareNoteToJira, type ShareResult } from "@/lib/jira/sync";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability("jira.share-comments");
    const limit = checkRateLimit(`jira:comment:${ctx.userId}`, { limit: 30, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await params;
    if (!UUID.test(id)) throw new ApiError(400, "bad_request", "Invalid link");
    const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text || text.length > 20_000) throw new ApiError(400, "bad_request", "Write a comment first");

    const j = await loadJiraContext(ctx, request);
    const link = await j.store.getLink(id);
    if (!link || link.account_id !== ctx.accountId) throw new ApiError(404, "not_found", "Link not found");
    if (link.sync_state !== "ok") throw new ApiError(409, "link_not_ok", "This link is paused or broken");

    // The note is written under the caller's own session, so RLS decides whether they may.
    const { data: note, error } = await ctx.supabase
      .from("ticket_comments")
      .insert({ ticket_id: link.ticket_id, account_id: ctx.accountId, author_id: ctx.userId, body: text, mentions: [] })
      .select("id")
      .single();
    if (error || !note) throw new ApiError(403, "not_allowed", "You cannot comment on this ticket");

    const noteId = (note as { id: string }).id;
    let results: ShareResult[];
    try {
      results = await shareNoteToJira(j.sync, { noteId, actorUserId: ctx.userId, linkId: id });
    } catch (e) {
      if ((e as { retryable?: boolean })?.retryable) {
        // Jira is busy or down: the note is saved, the post is queued (the cron retries with backoff).
        await j.store.enqueue({
          accountId: ctx.accountId,
          connectionId: j.connection.id,
          kind: "post_comment",
          payload: { note_id: noteId, actor: ctx.userId, link_id: id },
          dedupeKey: `post:${noteId}`,
        });
        return NextResponse.json({ noteId, queued: true }, { status: 202 });
      }
      throw e;
    }
    return NextResponse.json({ noteId, results }, { status: results.every((r) => r.ok) ? 201 : 207 });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
