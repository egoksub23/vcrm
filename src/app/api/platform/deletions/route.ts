// ============================================================
// GET /api/platform/deletions — which workspaces have a deletion pending or
// running (migration 153), for the operator console.
//
// Operator only (requirePlatformAdmin); platform_deletion_overview() re-checks.
// ============================================================
import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/platform/auth";

export async function GET() {
  try {
    const ctx = await requirePlatformAdmin();
    const { data, error } = await ctx.supabase.rpc("platform_deletion_overview");
    if (error) {
      console.error("[GET /api/platform/deletions] rpc error:", error);
      return NextResponse.json({ error: "Failed to load deletions" }, { status: 500 });
    }
    return NextResponse.json({ deletions: data ?? [] }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
