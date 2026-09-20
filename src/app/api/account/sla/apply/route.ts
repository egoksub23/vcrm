// ============================================================
// POST /api/account/sla/apply  (sla.configure)
//
// The one-time "Apply to open tickets" button. Open, in-progress and pending
// tickets that have no SLA at all get the first matching policy, computed from
// their created_at (an old ticket can start out breached).
//   { dryRun: true }   -> { matched, overdue, examined, truncated, applied: false }
//   { dryRun: false }  -> the same, applied: true
// The screen always asks with dryRun first and shows "N tickets will get an
// SLA; already-overdue ones will show as breached" before it applies.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { slaCatch, slaDbFail, slaFail } from "@/lib/sla/api";

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("sla.configure");
    // Deliberately tight: this walks up to 5000 tickets.
    const limit = checkRateLimit(`admin:slaApply:${ctx.userId}`, { limit: 10, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as { dryRun?: unknown } | null;
    if (typeof body?.dryRun !== "boolean") return slaFail("invalid_name");

    const { data, error } = await ctx.supabase.rpc("sla_apply_to_open_tickets", {
      p_account: ctx.accountId,
      p_dry_run: body.dryRun,
    });
    if (error) return slaDbFail("POST /api/account/sla/apply", error);
    return NextResponse.json(data);
  } catch (err) {
    return slaCatch(err);
  }
}
