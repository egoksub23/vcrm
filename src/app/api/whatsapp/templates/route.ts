import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const mine = searchParams.get("mine") === "true";

    let query = ctx.supabase.from("message_templates").select("*").order("name");
    if (status) query = query.eq("status", status);
    if (mine) query = query.eq("user_id", ctx.userId);

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ templates: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
