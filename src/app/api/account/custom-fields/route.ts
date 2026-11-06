import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data, error } = await ctx.supabase
      .from("custom_fields")
      .select("*")
      .eq("account_id", ctx.accountId)
      .order("field_name");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ fields: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as { field_name?: string } | null;
    if (!body?.field_name?.trim()) return NextResponse.json({ error: "field_name required" }, { status: 400 });
    const { data, error } = await ctx.supabase
      .from("custom_fields")
      .insert({ account_id: ctx.accountId, field_name: body.field_name.trim() })
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ field: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
