import { NextResponse } from "next/server";
import { getCurrentAccount, requireCapability, toErrorResponse } from "@/lib/auth/account";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id: contactId } = await params;
    const { data, error } = await ctx.supabase
      .from("contact_notes")
      .select("*")
      .eq("contact_id", contactId)
      .eq("account_id", ctx.accountId)
      .order("created_at", { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ notes: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("contacts.edit");
    const { id: contactId } = await params;
    const body = (await request.json().catch(() => null)) as { note_text?: string } | null;
    if (!body?.note_text?.trim()) return NextResponse.json({ error: "note_text required" }, { status: 400 });
    const { data, error } = await ctx.supabase
      .from("contact_notes")
      .insert({ contact_id: contactId, account_id: ctx.accountId, user_id: ctx.userId, note_text: body.note_text.trim() })
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ note: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
