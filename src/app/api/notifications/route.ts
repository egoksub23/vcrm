import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data, error } = await ctx.supabase
      .from("notifications")
      .select("*")
      .eq("account_id", ctx.accountId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ notifications: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

// PATCH with no body or { ids } — mark all (or specific) unread notifications as read
export async function PATCH(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as { read_at?: string; ids?: string[] } | null;
    const readAt = body?.read_at ?? new Date().toISOString();

    let query = ctx.supabase
      .from("notifications")
      .update({ read_at: readAt })
      .eq("account_id", ctx.accountId)
      .is("read_at", null);

    if (body?.ids?.length) {
      query = query.in("id", body.ids);
    }

    const { error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
