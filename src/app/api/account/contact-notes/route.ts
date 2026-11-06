import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const { searchParams } = new URL(request.url);
    const contactId = searchParams.get("contactId");
    if (!contactId) return NextResponse.json({ notes: [] });

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

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as {
      contact_id?: string;
      note_text?: string;
    } | null;
    if (!body?.contact_id || !body?.note_text?.trim()) {
      return NextResponse.json({ error: "contact_id and note_text required" }, { status: 400 });
    }

    const { data, error } = await ctx.supabase
      .from("contact_notes")
      .insert({
        contact_id: body.contact_id,
        account_id: ctx.accountId,
        user_id: ctx.userId,
        note_text: body.note_text.trim(),
      })
      .select()
      .single();

    if (error || !data) return NextResponse.json({ error: error?.message ?? "insert_failed" }, { status: 500 });
    return NextResponse.json({ note: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
