import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

// GET /api/sign/settings/basic
// The workspace's Doc Sign settings row for callers with any sign access.
// (The full /api/sign/settings route requires sign.settings capability.)
export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data, error } = await ctx.supabase
      .from("sign_settings")
      .select("*")
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (error) {
      console.error("[GET /api/sign/settings/basic] fetch error:", error);
      return NextResponse.json({ error: "Failed to load settings" }, { status: 500 });
    }
    return NextResponse.json({ settings: data ?? null });
  } catch (err) {
    return toErrorResponse(err);
  }
}
