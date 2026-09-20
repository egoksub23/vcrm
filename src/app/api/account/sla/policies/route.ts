// ============================================================
// POST /api/account/sla/policies  (sla.configure)
//
// Create a ticket SLA policy (migration 086):
//   { name, conditions?, first_response_minutes?, resolution_minutes?,
//     schedule_id?, pause_while_pending?, at_risk_percent?, is_active? }
// At least one target is required; resolution must be longer than first
// response. The policy goes to the end of the order (drag to reorder).
// Reading policies needs no route: every member can read the table (RLS).
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { slaCatch, slaDbFail, slaFail } from "@/lib/sla/api";
import { validatePolicyPayload } from "@/lib/sla/policy";

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("sla.configure");
    const limit = checkRateLimit(`admin:slaPolicy:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    const checked = validatePolicyPayload(body, false);
    if (!checked.ok) return slaFail(checked.code);

    const { data: policy, error } = await ctx.supabase
      .from("ticket_sla_policies")
      .insert({ account_id: ctx.accountId, ...checked.value })
      .select("*")
      .single();
    if (error || !policy) return slaDbFail("POST /api/account/sla/policies", error);
    return NextResponse.json({ policy }, { status: 201 });
  } catch (err) {
    return slaCatch(err);
  }
}
