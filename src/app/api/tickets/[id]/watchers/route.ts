import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { data, error } = await ctx.supabase
      .from("ticket_watchers")
      .select("*")
      .eq("ticket_id", id)
      .eq("account_id", ctx.accountId)
      .order("created_at", { ascending: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ watchers: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(_req: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { error } = await ctx.supabase
      .from("ticket_watchers")
      .insert({ ticket_id: id, user_id: ctx.userId, account_id: ctx.accountId });
    if (error && error.code !== "23505") return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { error } = await ctx.supabase
      .from("ticket_watchers")
      .delete()
      .eq("ticket_id", id)
      .eq("user_id", ctx.userId)
      .eq("account_id", ctx.accountId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
