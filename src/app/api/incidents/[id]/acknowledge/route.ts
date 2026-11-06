// POST /api/incidents/[id]/acknowledge — a manager acknowledges the incident inside Halo. Every notice still waiting for an acknowledgement
// counts as acknowledged, which stops the "nobody acknowledged" reminders. Requires incidents.manage.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { acknowledgeInApp } from "@/lib/incidents/platform/ack";

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.manage");
    const { id } = await params;
    // Same visibility as the incident itself: a manager of another school gets a 404.
    const { data: inc } = await ctx.supabase.from("incidents").select("id").eq("id", id).eq("account_id", ctx.accountId).maybeSingle();
    if (!inc) return NextResponse.json({ error: "Incident not found." }, { status: 404 });
    const count = await acknowledgeInApp(id, ctx.accountId, ctx.userId);
    return NextResponse.json({ ok: true, acknowledged: count });
  } catch (err) {
    return toErrorResponse(err);
  }
}
