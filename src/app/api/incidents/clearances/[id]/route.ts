// DELETE /api/incidents/clearances/[id] — mark a Return to Play date as cleared early (the student may play now). The row stays, with the time it was cleared.
// Requires incidents.medical.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { createAdminPgDb } from "@/lib/postgres/db";

type Params = { params: Promise<{ id: string }> };

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.medical");
    const { id } = await params;
    const { data, error } = await createAdminPgDb()
      .from("person_clearances")
      .update({ cleared_at: new Date().toISOString(), set_by: ctx.userId })
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .is("cleared_at", null)
      .select("id")
      .maybeSingle();
    if (error) return NextResponse.json({ error: "Could not clear the date." }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Date not found, or it was already cleared." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
