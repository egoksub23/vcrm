// ============================================================
// GET  /api/account/support-access  (settings.workspace) — the grants and who has looked
// POST /api/account/support-access  (owner) — allow support access
//
// POST body: { hours: 1..168, reason?: string, operatorUserId?: uuid }
//
// Support access (migration 154) lets a platform operator see DIAGNOSTICS of this
// workspace (plan, channel health, failed-send counts, job counts, usage, member
// counts) and never its conversations, contacts or secrets. Only the owner can allow
// it, for up to 7 days; every look is written to a log the workspace's admins read
// here. Read through the caller's own client, so the table policies are the gate.
// ============================================================
import { NextResponse } from "next/server";

import { requireCapability, requireRole, toErrorResponse } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET() {
  try {
    const ctx = await requireCapability("settings.workspace");
    const [grants, log] = await Promise.all([
      ctx.supabase
        .from("support_access_grants")
        .select("id, operator_user_id, reason, created_at, expires_at, revoked_at")
        .eq("account_id", ctx.accountId)
        .order("created_at", { ascending: false })
        .limit(20),
      ctx.supabase
        .from("support_access_log")
        .select("id, grant_id, operator_label, section, created_at")
        .eq("account_id", ctx.accountId)
        .order("created_at", { ascending: false })
        .limit(50),
    ]);
    if (grants.error || log.error) {
      console.error("[GET /api/account/support-access]", grants.error ?? log.error);
      return NextResponse.json({ error: "Failed to load support access" }, { status: 500 });
    }
    return NextResponse.json(
      { grants: grants.data ?? [], log: log.data ?? [] },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("owner");
    const limit = checkRateLimit(`support-access:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as
      | { hours?: unknown; reason?: unknown; operatorUserId?: unknown }
      | null;
    const hours = body?.hours;
    if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 1 || hours > 168) {
      return NextResponse.json({ error: "'hours' must be a whole number from 1 to 168" }, { status: 400 });
    }
    const operator = body?.operatorUserId;
    if (operator !== undefined && operator !== null && (typeof operator !== "string" || !UUID_RE.test(operator))) {
      return NextResponse.json({ error: "'operatorUserId' must be a valid id" }, { status: 400 });
    }
    const reason = typeof body?.reason === "string" ? body.reason.slice(0, 500) : null;

    const { data, error } = await ctx.supabase.rpc("support_grant_access", {
      p_account: ctx.accountId,
      p_hours: hours,
      p_reason: reason,
      p_operator: operator ?? null,
    });
    if (error) {
      if (error.code === "42501") return NextResponse.json({ error: error.message }, { status: 403 });
      if (error.code === "22023") return NextResponse.json({ error: error.message }, { status: 400 });
      console.error("[POST /api/account/support-access] rpc error:", error);
      return NextResponse.json({ error: "Could not allow support access" }, { status: 500 });
    }
    return NextResponse.json({ id: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
