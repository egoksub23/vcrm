import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const { searchParams } = new URL(request.url);
    const entityType = searchParams.get("entityType");
    const entityId = searchParams.get("entityId");
    if (!entityType || !entityId) {
      return NextResponse.json({ patch: null });
    }
    const { data } = await ctx.supabase
      .from("approval_pending_edits")
      .select("patch")
      .eq("entity_type", entityType)
      .eq("entity_id", entityId)
      .maybeSingle();
    return NextResponse.json({ patch: (data?.patch as Record<string, unknown> | null) ?? null });
  } catch (err) {
    return toErrorResponse(err);
  }
}
