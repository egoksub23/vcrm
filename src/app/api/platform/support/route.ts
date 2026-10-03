// ============================================================
// GET /api/platform/support — the workspaces this operator may look at right now
// (migration 154): the ones whose owner has allowed support access and not yet
// ended or let it expire.
//
// Operator only (requirePlatformAdmin); platform_support_grants() re-checks.
// ============================================================
import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/platform/auth";

export async function GET() {
  try {
    const ctx = await requirePlatformAdmin();
    const { data, error } = await ctx.supabase.rpc("platform_support_grants");
    if (error) {
      console.error("[GET /api/platform/support] rpc error:", error);
      return NextResponse.json({ error: "Failed to load support access" }, { status: 500 });
    }
    return NextResponse.json({ grants: data ?? [] }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
