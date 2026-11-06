import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    // pipeline_stages has no account_id — join through pipelines
    const { data: pipelines, error: plErr } = await ctx.supabase
      .from("pipelines")
      .select("id")
      .eq("account_id", ctx.accountId);
    if (plErr) return NextResponse.json({ error: plErr.message }, { status: 500 });
    const pipelineIds = (pipelines ?? []).map((p) => p.id);
    if (pipelineIds.length === 0) return NextResponse.json({ stages: [] });
    const { data, error } = await ctx.supabase
      .from("pipeline_stages")
      .select("*")
      .in("pipeline_id", pipelineIds)
      .order("position");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ stages: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
