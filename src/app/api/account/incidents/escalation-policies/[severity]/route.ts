// ============================================================
// /api/account/incidents/escalation-policies/[severity]
//
//   PUT    — upsert `{ level_1_minutes, level_2_minutes, schedule_id? }`
//            for this severity. `incident_escalation_policies` is
//            (account_id, severity) keyed — one row per severity, not a
//            reorderable list like ticket SLA policies. The write
//            trigger (migration 122) automatically recomputes
//            `next_escalation_due_at` on every open incident of this
//            severity.
//   DELETE — removes the override row, falling back to
//            incident_escalation_default_minutes() and 24/7 (no schedule).
//
// No GET — RLS already lets every account member read
// incident_escalation_policies directly (mirrors ticket_sla_policies).
// ============================================================
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";

const SEVERITIES = ["P1", "P2", "P3", "P4"] as const;
type Severity = (typeof SEVERITIES)[number];

function isSeverity(v: string): v is Severity {
  return (SEVERITIES as readonly string[]).includes(v);
}

export async function PUT(request: Request, { params }: { params: Promise<{ severity: string }> }) {
  try {
    const ctx = await requireCapability("incidents.manage");
    const { severity } = await params;
    if (!isSeverity(severity)) {
      return NextResponse.json({ error: "severity must be one of P1, P2, P3, P4" }, { status: 400 });
    }

    const body = (await request.json().catch(() => null)) as {
      level_1_minutes?: unknown;
      level_2_minutes?: unknown;
      schedule_id?: unknown;
    } | null;

    const level1 = Number(body?.level_1_minutes);
    const level2 = Number(body?.level_2_minutes);
    if (!Number.isInteger(level1) || level1 < 1 || level1 > 525600) {
      return NextResponse.json({ error: "level_1_minutes must be an integer between 1 and 525600" }, { status: 400 });
    }
    if (!Number.isInteger(level2) || level2 < 1 || level2 > 525600) {
      return NextResponse.json({ error: "level_2_minutes must be an integer between 1 and 525600" }, { status: 400 });
    }
    const scheduleId =
      body?.schedule_id === null || body?.schedule_id === undefined
        ? null
        : typeof body.schedule_id === "string"
          ? body.schedule_id
          : undefined;
    if (scheduleId === undefined) {
      return NextResponse.json({ error: "schedule_id must be a string or null" }, { status: 400 });
    }

    const { data, error } = await ctx.supabase
      .from("incident_escalation_policies")
      .upsert(
        {
          account_id: ctx.accountId,
          severity,
          level_1_minutes: level1,
          level_2_minutes: level2,
          schedule_id: scheduleId,
          updated_by: ctx.userId,
        },
        { onConflict: "account_id,severity" },
      )
      .select("*")
      .single();

    if (error) {
      console.error("[PUT /api/account/incidents/escalation-policies/[severity]] upsert error:", error);
      return NextResponse.json({ error: "Failed to save the escalation timer" }, { status: 500 });
    }

    return NextResponse.json({ policy: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ severity: string }> }) {
  try {
    const ctx = await requireCapability("incidents.manage");
    const { severity } = await params;
    if (!isSeverity(severity)) {
      return NextResponse.json({ error: "severity must be one of P1, P2, P3, P4" }, { status: 400 });
    }

    const { error } = await ctx.supabase
      .from("incident_escalation_policies")
      .delete()
      .eq("account_id", ctx.accountId)
      .eq("severity", severity);

    if (error) {
      console.error("[DELETE /api/account/incidents/escalation-policies/[severity]] delete error:", error);
      return NextResponse.json({ error: "Failed to reset the escalation timer" }, { status: 500 });
    }

    return NextResponse.json({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
