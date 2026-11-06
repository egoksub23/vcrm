import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

type Params = { params: Promise<{ id: string; commentId: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { commentId } = await params;
    const body = (await request.json().catch(() => null)) as { body?: string } | null;
    const text = body?.body?.trim();
    if (!text) return NextResponse.json({ error: "body required" }, { status: 400 });

    const { data, error } = await ctx.supabase
      .from("ticket_comments")
      .update({ body: text })
      .eq("id", commentId)
      .eq("account_id", ctx.accountId)
      .select("*")
      .maybeSingle();
    if (error || !data) return NextResponse.json({ error: error?.message ?? "not_found" }, { status: error ? 500 : 404 });
    return NextResponse.json({ comment: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { commentId } = await params;
    const { error } = await ctx.supabase
      .from("ticket_comments")
      .delete()
      .eq("id", commentId)
      .eq("account_id", ctx.accountId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
