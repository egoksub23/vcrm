// PATCH /api/incidents/[id]/comments/[commentId] — change a note. Body: { is_finding?: boolean, body?: string }. Requires incidents.manage.
//   is_finding  mark a note as a finding (or unmark it): it stands out in the Timeline and in the report for filing
//   body        correct what the note says (migration 229): the earlier wording is kept in the note's history and shown in the Audit log
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { createAdminPgDb } from "@/lib/postgres/db";

type Params = { params: Promise<{ id: string; commentId: string }> };

const MAX_NOTE = 10000;

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.manage");
    const { id, commentId } = await params;
    const body = (await request.json().catch(() => null)) as { is_finding?: unknown; body?: unknown } | null;

    const patch: Record<string, unknown> = {};
    if (body?.is_finding !== undefined) {
      if (typeof body.is_finding !== "boolean") return NextResponse.json({ error: "'is_finding' must be true or false" }, { status: 400 });
      patch.is_finding = body.is_finding;
    }
    if (body?.body !== undefined) {
      const text = typeof body.body === "string" ? body.body.trim() : "";
      if (!text) return NextResponse.json({ error: "A note cannot be empty." }, { status: 400 });
      if (text.length > MAX_NOTE) return NextResponse.json({ error: `A note can be ${MAX_NOTE} characters at most.` }, { status: 400 });
      patch.body = text;
      patch.edited_by = ctx.userId;
    }
    if (Object.keys(patch).length === 0) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });

    // Read as the person first: another school's incident, or a note on one they cannot see, is a 404.
    const { data: row } = await ctx.supabase.from("incident_comments").select("id, body").eq("id", commentId).eq("incident_id", id).eq("account_id", ctx.accountId).maybeSingle();
    if (!row) return NextResponse.json({ error: "Note not found." }, { status: 404 });
    // Saving the same words again is not an edit: no new "edited" mark, no history entry.
    if (patch.body !== undefined && patch.body === (row as { body: string }).body) {
      delete patch.body;
      delete patch.edited_by;
      if (Object.keys(patch).length === 0) return NextResponse.json({ ok: true, unchanged: true });
    }

    const { data, error } = await createAdminPgDb().from("incident_comments").update(patch).eq("id", commentId).eq("incident_id", id).eq("account_id", ctx.accountId).select("id, body, is_finding, edited_at, edited_by, previous_versions").single();
    if (error || !data) return NextResponse.json({ error: "Could not save that change." }, { status: 500 });
    return NextResponse.json({ ok: true, comment: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
