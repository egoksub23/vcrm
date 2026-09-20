// ============================================================
// /api/account/sla/schedules/[id]  (sla.configure)
//
//   PATCH  { name?, timezone?, weekly?, is_default?, holidays? }
//          `holidays`, when sent, is the COMPLETE list: missing dates are
//          removed, new ones added, renamed ones updated.
//   DELETE Blocked with `schedule_in_use` (409) while a policy uses it. Deleting
//          the default promotes the oldest remaining schedule.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { diffHolidays, parseHolidays, slaCatch, slaDbFail, slaFail } from "@/lib/sla/api";
import { isUuid, validateSchedulePayload } from "@/lib/sla/policy";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("sla.configure");
    const limit = checkRateLimit(`admin:slaSchedule:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!isUuid(id)) return slaFail("not_found");
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const checked = validateSchedulePayload(body, true);
    if (!checked.ok) return slaFail(checked.code);
    const holidays = body?.holidays === undefined ? null : parseHolidays(body.holidays);
    if (holidays && !holidays.ok) return slaFail(holidays.code);
    if (Object.keys(checked.value).length === 0 && !holidays) return slaFail("invalid_name");

    const { data: existing } = await ctx.supabase
      .from("business_hours_schedules")
      .select("id")
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (!existing) return slaFail("not_found");

    if (Object.keys(checked.value).length > 0) {
      const { error } = await ctx.supabase
        .from("business_hours_schedules")
        .update(checked.value)
        .eq("id", id)
        .eq("account_id", ctx.accountId);
      if (error) return slaDbFail("PATCH /api/account/sla/schedules/[id]", error);
    }

    if (holidays && holidays.ok) {
      const { data: stored, error: readError } = await ctx.supabase
        .from("business_hours_holidays")
        .select("id, holiday_date, name")
        .eq("schedule_id", id);
      if (readError) return slaDbFail("PATCH /api/account/sla/schedules/[id] (read holidays)", readError);
      const plan = diffHolidays(
        (stored ?? []) as { id: string; holiday_date: string; name: string }[],
        holidays.value,
      );
      if (plan.remove.length > 0) {
        const { error } = await ctx.supabase.from("business_hours_holidays").delete().in("id", plan.remove);
        if (error) return slaDbFail("PATCH /api/account/sla/schedules/[id] (remove holidays)", error);
      }
      for (const r of plan.rename) {
        const { error } = await ctx.supabase.from("business_hours_holidays").update({ name: r.name }).eq("id", r.id);
        if (error) return slaDbFail("PATCH /api/account/sla/schedules/[id] (rename holiday)", error);
      }
      if (plan.add.length > 0) {
        const { error } = await ctx.supabase
          .from("business_hours_holidays")
          .insert(plan.add.map((h) => ({ schedule_id: id, account_id: ctx.accountId, ...h })));
        if (error) return slaDbFail("PATCH /api/account/sla/schedules/[id] (add holidays)", error);
      }
    }

    const { data: schedule } = await ctx.supabase
      .from("business_hours_schedules")
      .select("id, account_id, name, timezone, is_default, weekly, created_at, updated_at")
      .eq("id", id)
      .maybeSingle();
    return NextResponse.json({ schedule });
  } catch (err) {
    return slaCatch(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("sla.configure");
    const limit = checkRateLimit(`admin:slaSchedule:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!isUuid(id)) return slaFail("not_found");

    // A friendly answer before the foreign key has to say no.
    const { count } = await ctx.supabase
      .from("ticket_sla_policies")
      .select("id", { count: "exact", head: true })
      .eq("schedule_id", id)
      .eq("account_id", ctx.accountId);
    if ((count ?? 0) > 0) return slaFail("schedule_in_use");

    const { data, error } = await ctx.supabase
      .from("business_hours_schedules")
      .delete()
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .select("id");
    if (error) return slaDbFail("DELETE /api/account/sla/schedules/[id]", error);
    if (!data || data.length === 0) return slaFail("not_found");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return slaCatch(err);
  }
}
