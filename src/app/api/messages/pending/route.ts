// GET  — list all pending-delete messages with their contact info
// POST { action: "restore", id }  — clear the pending_delete flag
// POST { action: "delete", id }   — permanently delete one message
// POST { action: "empty" }        — permanently delete all pending-delete messages
import { NextResponse } from "next/server";
import { requireCapability, toErrorResponse } from "@/lib/auth/account";

const SELECT =
  "id, content_text, channel_type, pending_delete_at, conversation_id, media_url, conversation:conversations(contact:contacts(name, phone, email, wallet_id))";

export async function GET() {
  try {
    const ctx = await requireCapability("messages.send");
    const { data, error } = await ctx.supabase
      .from("messages")
      .select(SELECT)
      .eq("pending_delete", true)
      .order("pending_delete_at", { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ messages: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("messages.send");
    const body = (await request.json().catch(() => null)) as { action?: string; id?: string } | null;
    const action = body?.action;
    const id = body?.id;

    if (action === "restore") {
      if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
      const { error } = await ctx.supabase
        .from("messages")
        .update({ pending_delete: false, pending_delete_at: null })
        .eq("id", id)
        .eq("account_id", ctx.accountId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true });
    }

    if (action === "delete") {
      if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
      const { error } = await ctx.supabase
        .from("messages")
        .delete()
        .eq("id", id)
        .eq("account_id", ctx.accountId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true });
    }

    if (action === "empty") {
      const { error } = await ctx.supabase
        .from("messages")
        .delete()
        .eq("pending_delete", true)
        .eq("account_id", ctx.accountId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
