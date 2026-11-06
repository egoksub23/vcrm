import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

const COLUMNS =
  "id, account_id, ticket_id, comment_id, mentioned_user_id, requested_by, via_team_id, kind, status, created_at, resolved_at, resolved_by, resolved_reason, nudged_at";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { data, error } = await ctx.supabase
      .from("ticket_mentions")
      .select(COLUMNS)
      .eq("account_id", ctx.accountId)
      .eq("ticket_id", id)
      .eq("status", "open")
      .eq("kind", "response")
      .order("created_at", { ascending: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ mentions: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
