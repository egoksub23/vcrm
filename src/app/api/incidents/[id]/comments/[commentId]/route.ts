// PATCH /api/incidents/[id]/comments/[commentId] — mark a note as a finding (or unmark it). Body: { is_finding: boolean }. Requires incidents.manage.
// A finding stands out in the Timeline and in the report for filing. The note itself is never edited here.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { createAdminPgDb } from "@/lib/postgres/db";

type Params = { params: Promise<{ id: string; commentId: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.manage");
    const { id, commentId } = await params;
    const body = (await request.json().catch(() => null)) as { is_finding?: unknown } | null;
    if (typeof body?.is_finding !== "boolean") return NextResponse.json({ error: "'is_finding' must be true or false" }, { status: 400 });

    // Read as the person first: another school's incident, or a note on one they cannot see, is a 404.
    const { data: row } = await ctx.supabase.from("incident_comments").select("id").eq("id", commentId).eq("incident_id", id).eq("account_id", ctx.accountId).maybeSingle();
    if (!row) return NextResponse.json({ error: "Note not found." }, { status: 404 });

    const { error } = await createAdminPgDb().from("incident_comments").update({ is_finding: body.is_finding }).eq("id", commentId).eq("incident_id", id).eq("account_id", ctx.accountId);
    if (error) return NextResponse.json({ error: "Could not save that change." }, { status: 500 });
    return NextResponse.json({ ok: true, is_finding: body.is_finding });
  } catch (err) {
    return toErrorResponse(err);
  }
}
