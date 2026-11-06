import { NextResponse } from "next/server";
import { requireCapability, toErrorResponse } from "@/lib/auth/account";

type Params = { params: Promise<{ id: string; noteId: string }> };

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("contacts.edit");
    const { noteId } = await params;
    const { error } = await ctx.supabase
      .from("contact_notes")
      .delete()
      .eq("id", noteId)
      .eq("account_id", ctx.accountId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
