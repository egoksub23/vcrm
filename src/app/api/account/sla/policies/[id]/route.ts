// ============================================================
// /api/account/sla/policies/[id]  (sla.configure)
//
//   PATCH  Any of the create fields. Editing a policy changes the tickets that
//          MATCH it from now on; tickets that already have an SLA keep the due
//          times they were given (they are re-matched only when their priority,
//          type, labels, team or conversation change).
//   DELETE Running SLAs under it end; finished ones (met / breached) stay.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { slaCatch, slaDbFail, slaFail } from "@/lib/sla/api";
import { isUuid, validatePolicyPayload } from "@/lib/sla/policy";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("sla.configure");
    const limit = checkRateLimit(`admin:slaPolicy:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!isUuid(id)) return slaFail("not_found");
    const body = await request.json().catch(() => null);
    const checked = validatePolicyPayload(body, true);
    if (!checked.ok) return slaFail(checked.code);
    if (Object.keys(checked.value).length === 0) return slaFail("invalid_name");

    const { data, error } = await ctx.supabase
      .from("ticket_sla_policies")
      .update(checked.value)
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .select("*")
      .maybeSingle();
    if (error) return slaDbFail("PATCH /api/account/sla/policies/[id]", error);
    if (!data) return slaFail("not_found");
    return NextResponse.json({ policy: data });
  } catch (err) {
    return slaCatch(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("sla.configure");
    const limit = checkRateLimit(`admin:slaPolicy:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!isUuid(id)) return slaFail("not_found");
    const { data, error } = await ctx.supabase
      .from("ticket_sla_policies")
      .delete()
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .select("id");
    if (error) return slaDbFail("DELETE /api/account/sla/policies/[id]", error);
    if (!data || data.length === 0) return slaFail("not_found");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return slaCatch(err);
  }
}
