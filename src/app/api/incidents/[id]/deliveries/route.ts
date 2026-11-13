// GET /api/incidents/[id]/deliveries — the message log for one incident: who was told, how, and what became of it. Requires incidents.manage.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.manage");
    const { id } = await params;
    const { data, error } = await ctx.supabase
      .from("incident_deliveries")
      .select("id, role_key, recipient_name, channel, address, reason, ask_ack, status, attempts, last_error, sent_at, acknowledged_at, is_test, created_at")
      .eq("incident_id", id)
      .eq("account_id", ctx.accountId)
      .order("created_at", { ascending: true });
    if (error) return NextResponse.json({ error: "Could not load the message log." }, { status: 500 });
    return NextResponse.json({ deliveries: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
