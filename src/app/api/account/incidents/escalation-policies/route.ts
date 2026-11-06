import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data, error } = await ctx.supabase
      .from("incident_escalation_policies")
      .select("*")
      .eq("account_id", ctx.accountId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ policies: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
