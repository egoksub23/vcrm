import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { processIncidentEvent } from "@/lib/incidents/platform/run";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

    const { error } = await ctx.supabase
      .from("incidents")
      .update(body)
      .eq("id", id)
      .eq("account_id", ctx.accountId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    // Closing an incident can trigger "tell the Principal" style rules.
    if (body.status === "closed") await processIncidentEvent(id, "closed");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
