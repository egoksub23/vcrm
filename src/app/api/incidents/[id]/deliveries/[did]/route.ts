// POST /api/incidents/[id]/deliveries/[did] — retry a message that failed. Requires incidents.manage; the row is re-queued and sent at once.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { defaultAdapters } from "@/lib/incidents/platform/adapters";
import { dispatchDue } from "@/lib/incidents/platform/engine";
import { PgEngineStore } from "@/lib/incidents/platform/pg-store";
import { createAdminPgDb } from "@/lib/postgres/db";

type Params = { params: Promise<{ id: string; did: string }> };

export async function POST(_request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.manage");
    const { id, did } = await params;

    // Read as the caller first, so a delivery from another school (or one they cannot see) is a 404 here.
    const { data: seen } = await ctx.supabase.from("incident_deliveries").select("id, status").eq("id", did).eq("incident_id", id).eq("account_id", ctx.accountId).maybeSingle();
    const row = seen as { id: string; status: string } | null;
    if (!row) return NextResponse.json({ error: "Message not found." }, { status: 404 });
    if (row.status !== "failed") return NextResponse.json({ error: "Only a message that failed can be retried." }, { status: 409 });

    // The log has no client write policy: re-queue it with the service connection.
    const admin = createAdminPgDb();
    const { error } = await admin
      .from("incident_deliveries")
      .update({ status: "queued", attempts: 0, next_attempt_at: new Date().toISOString(), last_error: null })
      .eq("id", did)
      .eq("account_id", ctx.accountId);
    if (error) return NextResponse.json({ error: "Could not retry the message." }, { status: 500 });

    const summary = await dispatchDue(new PgEngineStore(admin), defaultAdapters(), 20);
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    return toErrorResponse(err);
  }
}
