import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

// GET /api/account/inbox-views
// Returns the caller's own saved inbox views plus every shared one
// (owner_id IS NULL), ordered by created_at ascending.
// This replicates the RLS policy that inbox_views_select enforced.
export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data, error } = await ctx.supabase
      .from("inbox_views")
      .select("*")
      .eq("account_id", ctx.accountId)
      .or(`owner_id.eq.${ctx.userId},owner_id.is.null`)
      .order("created_at", { ascending: true });
    if (error) {
      console.error("[GET /api/account/inbox-views] fetch error:", error);
      return NextResponse.json({ error: "Failed to load inbox views" }, { status: 500 });
    }
    return NextResponse.json({ views: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
