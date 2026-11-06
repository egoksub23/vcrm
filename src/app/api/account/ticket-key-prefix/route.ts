import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data, error } = await ctx.supabase
      .from("accounts")
      .select("ticket_key_prefix")
      .eq("id", ctx.accountId)
      .maybeSingle();
    if (error) {
      console.error("[GET /api/account/ticket-key-prefix] fetch error:", error);
      return NextResponse.json({ error: "Failed to load prefix" }, { status: 500 });
    }
    const prefix = (data as { ticket_key_prefix?: string | null } | null)?.ticket_key_prefix ?? null;
    return NextResponse.json({ prefix });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as { prefix?: string | null } | null;
    if (!body) return NextResponse.json({ error: "body required" }, { status: 400 });
    const { error } = await ctx.supabase
      .from("accounts")
      .update({ ticket_key_prefix: body.prefix ?? null })
      .eq("id", ctx.accountId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
