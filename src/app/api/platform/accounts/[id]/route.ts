// ============================================================
// PATCH /api/platform/accounts/[id] — operator changes to one workspace:
//
//   { status?: 'active' | 'suspended', reason?, plan?, limits?, features? }
//
// Each field goes through the matching SECURITY DEFINER RPC
// (platform_set_account_status / platform_update_account), which re-check
// that the caller is a platform admin, so this route adds validation and
// rate limiting, not authority. Suspending pauses every channel of the
// workspace and blocks its members and API keys; resuming restores exactly
// what was switched on.
// ============================================================
import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/platform/auth";
import { parseUpdateTenant } from "@/lib/platform/validate";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requirePlatformAdmin();

    const limit = checkRateLimit(`platform:update:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: "Invalid workspace id" }, { status: 400 });
    }

    const parsed = parseUpdateTenant(await request.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const { status, reason, plan, limits, features, reseed } = parsed.value;

    if (plan !== undefined || limits !== undefined || features !== undefined) {
      const { error } = await ctx.supabase.rpc("platform_update_account", {
        p_account: id,
        p_plan: plan ?? null,
        p_limits: limits ?? null,
        p_features: features ?? null,
      });
      if (error) return rpcFailure("platform_update_account", error);
    }

    if (reseed) {
      const { error } = await ctx.supabase.rpc("platform_reseed_account", { p_account: id });
      if (error) return rpcFailure("platform_reseed_account", error);
    }

    if (status !== undefined) {
      const { error } = await ctx.supabase.rpc("platform_set_account_status", {
        p_account: id,
        p_status: status,
        p_reason: reason ?? null,
      });
      if (error) return rpcFailure("platform_set_account_status", error);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

function rpcFailure(name: string, error: { code?: string; message: string }) {
  // 22023 = the RPC's own validation message (account not found, bad value);
  // 42501 = not an operator. Anything else is ours to log, not to echo.
  if (error.code === "22023") {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error.code === "42501") {
    return NextResponse.json({ error: "Platform administrator access required" }, { status: 403 });
  }
  console.error(`[PATCH /api/platform/accounts/[id]] ${name} failed:`, error);
  return NextResponse.json({ error: "Update failed" }, { status: 500 });
}
