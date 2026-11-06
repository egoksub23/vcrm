import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

// GET /api/account/profiles — lightweight member list for pickers and avatars.
export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data, error } = await ctx.supabase
      .from("profiles")
      .select("*")
      .eq("account_id", ctx.accountId)
      .order("full_name");
    if (error) {
      console.error("[GET /api/account/profiles] fetch error:", error);
      return NextResponse.json({ error: "Failed to load profiles" }, { status: 500 });
    }
    return NextResponse.json({ profiles: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
