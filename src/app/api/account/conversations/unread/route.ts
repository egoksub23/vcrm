import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data, error } = await ctx.supabase
      .from("conversations")
      .select("id, unread_count")
      .eq("account_id", ctx.accountId);
    if (error) {
      console.error("[GET /api/account/conversations/unread] fetch error:", error);
      return NextResponse.json({ error: "Failed to load conversations" }, { status: 500 });
    }
    return NextResponse.json({ conversations: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
