// ============================================================
// /api/account/incidents/escalation-recipients/[id]
//
//   DELETE — removes one explicit recipient override by row id.
// ============================================================
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability("incidents.manage");
    const { id } = await params;

    const { data, error } = await ctx.supabase
      .from("incident_escalation_recipients")
      .delete()
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .select("id")
      .maybeSingle();

    if (error) {
      console.error("[DELETE /api/account/incidents/escalation-recipients/[id]] delete error:", error);
      return NextResponse.json({ error: "Failed to remove that recipient" }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({ error: "Recipient not found" }, { status: 404 });
    }

    return NextResponse.json({ removed: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
