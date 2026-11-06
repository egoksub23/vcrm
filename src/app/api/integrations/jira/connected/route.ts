import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data } = await ctx.supabase
      .from("jira_connections")
      .select("status, site_url")
      .eq("account_id", ctx.accountId)
      .limit(1);
    const row = ((data as { status: string; site_url: string }[] | null) ?? [])[0];
    return NextResponse.json({ active: row?.status === "active", siteUrl: row?.site_url ?? null });
  } catch (err) {
    return toErrorResponse(err);
  }
}
