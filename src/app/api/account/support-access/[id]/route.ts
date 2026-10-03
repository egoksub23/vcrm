// ============================================================
// DELETE /api/account/support-access/[id]  (owner) — end support access now
//
// The grant stops working at once (it also stops by itself when it expires).
// The database re-checks that the caller is the workspace owner.
// ============================================================
import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole("owner");
    const limit = checkRateLimit(`support-access:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

    const { error } = await ctx.supabase.rpc("support_revoke_access", { p_grant: id });
    if (error) {
      if (error.code === "42501") return NextResponse.json({ error: error.message }, { status: 403 });
      console.error("[DELETE /api/account/support-access] rpc error:", error);
      return NextResponse.json({ error: "Could not end support access" }, { status: 500 });
    }
    return NextResponse.json({ ended: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
