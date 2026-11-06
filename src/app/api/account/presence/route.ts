import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data, error } = await ctx.supabase
      .from("member_presence")
      .select("user_id, status, last_seen_at")
      .eq("account_id", ctx.accountId);
    if (error) {
      console.error("[GET /api/account/presence] fetch error:", error);
      return NextResponse.json({ error: "Failed to load presence" }, { status: 500 });
    }
    return NextResponse.json({ presence: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
