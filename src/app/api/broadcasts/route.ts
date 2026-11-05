import { NextResponse } from "next/server";
import { getCurrentAccount, requireCapability, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data, error } = await ctx.supabase
      .from("broadcasts")
      .select("*")
      .eq("account_id", ctx.accountId)
      .order("created_at", { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ broadcasts: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("broadcasts.send");
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "body required" }, { status: 400 });

    const { data, error } = await ctx.supabase
      .from("broadcasts")
      .insert({
        user_id: ctx.userId,
        account_id: ctx.accountId,
        name: body.name,
        template_name: body.template_name,
        template_language: body.template_language ?? "en_US",
        template_variables: body.template_variables ?? {},
        audience_filter: body.audience_filter ?? {},
        status: "draft",
        total_recipients: 0,
        sent_count: 0,
        delivered_count: 0,
        read_count: 0,
        replied_count: 0,
        failed_count: 0,
      })
      .select("id")
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ broadcast: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
