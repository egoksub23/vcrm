import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data, error } = await ctx.supabase
      .from("ticket_saved_filters")
      .select("*")
      .eq("account_id", ctx.accountId)
      .order("created_at", { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ filters: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as {
      name?: string;
      filter?: unknown;
      is_shared?: boolean;
    } | null;
    if (!body?.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });

    const { data, error } = await ctx.supabase
      .from("ticket_saved_filters")
      .insert({
        account_id: ctx.accountId,
        user_id: ctx.userId,
        name: body.name.trim().slice(0, 80),
        filter: body.filter ?? {},
        is_shared: body.is_shared ?? false,
      })
      .select("*")
      .single();

    if (error || !data) return NextResponse.json({ error: error?.message ?? "insert_failed" }, { status: 500 });
    return NextResponse.json({ filter: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
