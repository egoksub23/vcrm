import { NextResponse } from "next/server";
import { requireCapability, toErrorResponse } from "@/lib/auth/account";

const ALLOWED = ["default_currency", "currencies", "sla_response_minutes", "status_colors"] as const;

export async function PATCH(request: Request) {
  try {
    const ctx = await requireCapability("settings.workspace");
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "body required" }, { status: 400 });

    const patch: Record<string, unknown> = {};
    for (const key of ALLOWED) {
      if (key in body) patch[key] = body[key];
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "no updatable fields" }, { status: 400 });
    }

    const { error } = await ctx.supabase
      .from("accounts")
      .update(patch)
      .eq("id", ctx.accountId);

    if (error) {
      console.error("[PATCH /api/account/settings] update error:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
