import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data, error } = await ctx.supabase
      .from("team_members")
      .select("team_id")
      .eq("account_id", ctx.accountId)
      .limit(5000);
    if (error) {
      console.error("[GET /api/account/team-member-counts] fetch error:", error);
      return NextResponse.json({ error: "Failed to load team members" }, { status: 500 });
    }
    const counts: Record<string, number> = {};
    for (const row of (data ?? []) as { team_id: string }[]) {
      counts[row.team_id] = (counts[row.team_id] ?? 0) + 1;
    }
    return NextResponse.json({ counts });
  } catch (err) {
    return toErrorResponse(err);
  }
}
