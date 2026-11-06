// GET  /api/whatsapp/config/settings — raw whatsapp_config row for the form
// PATCH /api/whatsapp/config/settings — update simple boolean settings (mirror_inbound_media)
import { NextResponse } from "next/server";
import { requireCapability, toErrorResponse } from "@/lib/auth/account";

const ALLOWED_PATCH = ["mirror_inbound_media"] as const;

export async function GET() {
  try {
    const ctx = await requireCapability("settings.workspace");
    const { data, error } = await ctx.supabase
      .from("whatsapp_config")
      .select("*")
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ config: data ?? null });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireCapability("settings.workspace");
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "body required" }, { status: 400 });
    const patch: Record<string, unknown> = {};
    for (const key of ALLOWED_PATCH) {
      if (key in body) patch[key] = body[key];
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "no updatable fields" }, { status: 400 });
    }
    const { error } = await ctx.supabase
      .from("whatsapp_config")
      .update(patch)
      .eq("account_id", ctx.accountId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
