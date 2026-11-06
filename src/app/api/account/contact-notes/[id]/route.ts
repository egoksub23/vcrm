import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as { note_text?: string } | null;
    if (!body?.note_text?.trim()) return NextResponse.json({ error: "note_text required" }, { status: 400 });

    const { data, error } = await ctx.supabase
      .from("contact_notes")
      .update({ note_text: body.note_text.trim() })
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .select()
      .single();

    if (error || !data) return NextResponse.json({ error: error?.message ?? "update_failed" }, { status: 500 });
    return NextResponse.json({ note: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { error } = await ctx.supabase
      .from("contact_notes")
      .delete()
      .eq("id", id)
      .eq("account_id", ctx.accountId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
