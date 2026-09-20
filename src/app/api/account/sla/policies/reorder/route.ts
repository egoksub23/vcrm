// ============================================================
// PUT /api/account/sla/policies/reorder  (sla.configure)
//
//   { ids: [uuid, ...] }  the policies in their new order (first = evaluated
//   first). One database call (sla_reorder_policies), all or nothing.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { slaCatch, slaDbFail, slaFail } from "@/lib/sla/api";
import { isUuid } from "@/lib/sla/policy";
import { SLA_LIMITS } from "@/lib/sla/types";

export async function PUT(request: Request) {
  try {
    const ctx = await requireCapability("sla.configure");
    const limit = checkRateLimit(`admin:slaPolicy:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as { ids?: unknown } | null;
    const ids = body?.ids;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > SLA_LIMITS.maxPolicies ||
      !ids.every(isUuid) ||
      new Set(ids).size !== ids.length
    ) {
      return slaFail("invalid_name");
    }
    const { error } = await ctx.supabase.rpc("sla_reorder_policies", {
      p_account: ctx.accountId,
      p_ids: ids,
    });
    if (error) return slaDbFail("PUT /api/account/sla/policies/reorder", error);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return slaCatch(err);
  }
}
