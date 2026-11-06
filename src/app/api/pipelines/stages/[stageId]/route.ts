// GET  — deals count for this stage (?count=deals)
// DELETE — remove this stage (pipelines.configure); fails if deals still reference it
import { NextResponse } from "next/server";
import { getCurrentAccount, requireCapability, toErrorResponse } from "@/lib/auth/account";

type Params = { params: Promise<{ stageId: string }> };

export async function GET(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { stageId } = await params;
    const { searchParams } = new URL(request.url);
    if (searchParams.get("count") === "deals") {
      const { count, error } = await ctx.supabase
        .from("deals")
        .select("id", { count: "exact", head: true })
        .eq("stage_id", stageId)
        .eq("account_id", ctx.accountId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ count: count ?? 0 });
    }
    return NextResponse.json({ error: "unknown request" }, { status: 400 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("pipelines.configure");
    const { stageId } = await params;
    const { error } = await ctx.supabase.from("pipeline_stages").delete().eq("id", stageId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
