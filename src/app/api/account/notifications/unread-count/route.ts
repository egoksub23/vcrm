import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { count, error } = await ctx.supabase
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .eq("account_id", ctx.accountId)
      .eq("user_id", ctx.userId)
      .is("read_at", null);
    if (error) {
      console.error("[GET /api/account/notifications/unread-count] error:", error);
      return NextResponse.json({ error: "Failed to count notifications" }, { status: 500 });
    }
    return NextResponse.json({ count: count ?? 0 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
