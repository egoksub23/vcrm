// ============================================================
// POST /api/account/sla/schedules  (sla.configure)
//
// Create a business-hours schedule (migration 086):
//   { name, timezone, weekly, holidays?: [{ date, name }], is_default? }
// The first schedule of a workspace becomes its default; is_default: true
// makes this one the default (the previous default is swapped out). Reading
// schedules needs no route: every member can read the tables (RLS).
//
// Errors are `{ error: <code> }`; the screen translates the code.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { parseHolidays, slaCatch, slaDbFail, slaFail } from "@/lib/sla/api";
import { validateSchedulePayload } from "@/lib/sla/policy";

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("sla.configure");
    const limit = checkRateLimit(`admin:slaSchedule:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const checked = validateSchedulePayload(body, false);
    if (!checked.ok) return slaFail(checked.code);
    const holidays = body?.holidays === undefined ? { ok: true as const, value: [] } : parseHolidays(body.holidays);
    if (!holidays.ok) return slaFail(holidays.code);

    const { data: schedule, error } = await ctx.supabase
      .from("business_hours_schedules")
      .insert({ account_id: ctx.accountId, ...checked.value })
      .select("id, account_id, name, timezone, is_default, weekly, created_at, updated_at")
      .single();
    if (error || !schedule) return slaDbFail("POST /api/account/sla/schedules", error);

    if (holidays.value.length > 0) {
      const { error: holidayError } = await ctx.supabase.from("business_hours_holidays").insert(
        holidays.value.map((h) => ({ schedule_id: schedule.id, account_id: ctx.accountId, ...h })),
      );
      if (holidayError) {
        // Nothing half-made: take the new schedule back out.
        await ctx.supabase.from("business_hours_schedules").delete().eq("id", schedule.id);
        return slaDbFail("POST /api/account/sla/schedules (holidays)", holidayError);
      }
    }
    return NextResponse.json({ schedule }, { status: 201 });
  } catch (err) {
    return slaCatch(err);
  }
}
