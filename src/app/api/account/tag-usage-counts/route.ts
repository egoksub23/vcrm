import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data, error } = await ctx.supabase
      .from("tag_usage_counts")
      .select("tag_id, contact_count, conversation_count")
      .eq("account_id", ctx.accountId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ counts: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
