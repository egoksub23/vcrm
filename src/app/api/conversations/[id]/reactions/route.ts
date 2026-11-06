import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id: conversationId } = await params;
    const { data, error } = await ctx.supabase
      .from("message_reactions")
      .select("*")
      .eq("conversation_id", conversationId)
      .eq("account_id", ctx.accountId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ reactions: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
