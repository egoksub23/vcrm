// ============================================================
// /api/account/incidents/escalation-recipients
//
//   POST — body `{ level: 2 | 3, user_id: string }`. Adds one explicit
//          recipient override for that escalation level. Idempotent —
//          a duplicate add is a 409, not a 500 (the table's UNIQUE
//          (account_id, level, user_id) is what actually enforces this).
//
// No GET — RLS already lets every account member read
// incident_escalation_recipients directly.
// ============================================================
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("incidents.manage");

    const body = (await request.json().catch(() => null)) as { level?: unknown; user_id?: unknown } | null;
    const level = Number(body?.level);
    const userId = typeof body?.user_id === "string" ? body.user_id : "";
    if (level !== 2 && level !== 3) {
      return NextResponse.json({ error: "level must be 2 or 3" }, { status: 400 });
    }
    if (!userId) {
      return NextResponse.json({ error: "user_id is required" }, { status: 400 });
    }

    const { data, error } = await ctx.supabase
      .from("incident_escalation_recipients")
      .insert({ account_id: ctx.accountId, level, user_id: userId, added_by: ctx.userId })
      .select("*")
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: "That person is already a recipient at this level" }, { status: 409 });
      }
      console.error("[POST /api/account/incidents/escalation-recipients] insert error:", error);
      return NextResponse.json({ error: "Failed to add that recipient" }, { status: 500 });
    }

    return NextResponse.json({ recipient: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
