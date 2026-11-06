import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

const COLUMNS =
  "id, account_id, ticket_id, comment_id, mentioned_user_id, requested_by, via_team_id, kind, status, created_at, resolved_at, resolved_by, resolved_reason, nudged_at";

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const url = new URL(request.url);
    const kind = url.searchParams.get("kind") ?? "response";
    const status = url.searchParams.get("status") ?? "open";
    const { data, error } = await ctx.supabase
      .from("ticket_mentions")
      .select(COLUMNS)
      .eq("account_id", ctx.accountId)
      .eq("mentioned_user_id", ctx.userId)
      .eq("status", status)
      .eq("kind", kind)
      .order("created_at", { ascending: true })
      .limit(1000);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ mentions: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
