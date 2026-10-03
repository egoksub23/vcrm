// ============================================================
// GET /api/platform/accounts/[id]/support?section=<overview|channels|failures|members|jobs|usage>
//
// One diagnostic section of one workspace, while its owner has allowed support
// access (migration 154). Read-only; never message text, contact details, names,
// emails or secrets. Every call is written to the workspace's support access log
// inside the database, before the answer is returned. Called as the operator (the
// function needs the operator's own session and re-checks the role and the grant).
// ============================================================
import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/platform/auth";
import { isSupportSection } from "@/lib/platform/support";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requirePlatformAdmin();
    const limit = checkRateLimit(`platform:support:${ctx.userId}`, { limit: 60, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid workspace id" }, { status: 400 });
    const section = new URL(request.url).searchParams.get("section");
    if (!isSupportSection(section)) return NextResponse.json({ error: "Unknown section" }, { status: 400 });

    const { data, error } = await ctx.supabase.rpc("platform_support_view", { p_account: id, p_section: section });
    if (error) {
      if (error.code === "42501") return NextResponse.json({ error: "No active support access for this workspace" }, { status: 403 });
      if (error.code === "22023") return NextResponse.json({ error: error.message }, { status: 400 });
      console.error("[GET /api/platform/accounts/[id]/support] rpc error:", error);
      return NextResponse.json({ error: "Failed to load diagnostics" }, { status: 500 });
    }
    return NextResponse.json({ section, data }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
