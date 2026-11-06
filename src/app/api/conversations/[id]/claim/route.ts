import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

type Params = { params: Promise<{ id: string }> };

/** Claim an unassigned conversation — only succeeds if still unassigned and open (race-safe). */
export async function POST(_req: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { data, error } = await ctx.supabase
      .from("conversations")
      .update({ assigned_agent_id: ctx.userId })
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .is("assigned_agent_id", null)
      .neq("status", "closed")
      .select("id")
      .maybeSingle();
    if (error) {
      console.error("Failed to claim conversation:", error);
      return NextResponse.json({ claimed: false });
    }
    return NextResponse.json({ claimed: !!data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
