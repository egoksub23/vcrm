// /api/incidents/setup/business-hours — whether the waits on timed rules count in business hours (migration 227). Requires incidents.configure.
//   GET   the school's business-hours schedules (the same ones ticket SLAs use) and the one chosen for incidents, if any
//   PUT   { schedule_id: "<uuid>" | null }   choose a schedule, or null to count waits in elapsed time (the default)
// It applies to the three timed rules (nobody acknowledged, a required step overdue, still open). Required-step deadlines are still counted in elapsed hours.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await requireCapability("incidents.configure");
    const [schedules, settings] = await Promise.all([
      ctx.supabase.from("business_hours_schedules").select("id, name, timezone, is_default").eq("account_id", ctx.accountId).order("created_at", { ascending: true }),
      ctx.supabase.from("incident_settings").select("business_hours_schedule_id").eq("account_id", ctx.accountId).maybeSingle(),
    ]);
    return NextResponse.json(
      {
        schedules: schedules.data ?? [],
        schedule_id: (settings.data as { business_hours_schedule_id: string | null } | null)?.business_hours_schedule_id ?? null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const body = (await request.json().catch(() => null)) as { schedule_id?: unknown } | null;
    const id = body?.schedule_id;
    if (id !== null && typeof id !== "string") return NextResponse.json({ error: "'schedule_id' must be a schedule or null" }, { status: 400 });
    if (typeof id === "string") {
      const { data } = await ctx.supabase.from("business_hours_schedules").select("id").eq("id", id).eq("account_id", ctx.accountId).maybeSingle();
      if (!data) return NextResponse.json({ error: "That schedule was not found." }, { status: 404 });
    }
    const { error } = await ctx.supabase.from("incident_settings").upsert({ account_id: ctx.accountId, business_hours_schedule_id: id, updated_by: ctx.userId }, { onConflict: "account_id" });
    if (error) return NextResponse.json({ error: "Could not save the setting." }, { status: 500 });
    return NextResponse.json({ ok: true, schedule_id: id });
  } catch (err) {
    return toErrorResponse(err);
  }
}
