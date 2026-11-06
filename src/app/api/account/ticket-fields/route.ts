import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data, error } = await ctx.supabase
      .from("ticket_field_definitions")
      .select("*")
      .eq("account_id", ctx.accountId)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) {
      console.error("[GET /api/account/ticket-fields] fetch error:", error);
      return NextResponse.json({ error: "Failed to load ticket fields" }, { status: 500 });
    }
    return NextResponse.json({ fields: data ?? [] });
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
      .from("ticket_field_definitions")
      .insert({ ...body, account_id: ctx.accountId })
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ field: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
