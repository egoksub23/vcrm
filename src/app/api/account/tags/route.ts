import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const { searchParams } = new URL(request.url);
    const all = searchParams.get("all") === "true";
    let query = ctx.supabase.from("tags").select("*").eq("account_id", ctx.accountId);
    if (!all) query = query.eq("approval_status", "approved");
    const { data, error } = await query.order("name");
    if (error) {
      console.error("[GET /api/account/tags] fetch error:", error);
      return NextResponse.json({ error: "Failed to load tags" }, { status: 500 });
    }
    return NextResponse.json({ tags: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "body required" }, { status: 400 });
    const { data, error } = await ctx.supabase
      .from("tags")
      .insert({ ...body, account_id: ctx.accountId })
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ tag: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
