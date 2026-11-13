// ============================================================
// POST /api/incidents/[id]/escalate — manual "Escalate now". Body (optional): { level: 2 | 3 } to go straight to a level; without it the level goes up by one.
//
// Calls incident_escalate_manual() (migrations 116, 225), which does its own has_capability('incidents.manage') check, bumps the escalation level one step
// and records it. The people told are the roles the school's escalation rules name for the new level (processIncidentEvent), once for each level passed
// through. There is no separate list of names any more (migration 225). Mirrors the escalation-cron route's shape.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { processIncidentEvent } from "@/lib/incidents/platform/run";
import { deliverSchoolWebhookEvent } from "@/lib/incidents/platform/school-webhooks";
import { incidentKey } from "@/lib/incidents/types";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability("incidents.manage");
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as { level?: unknown } | null;

    const { data: current } = await ctx.supabase.from("incidents").select("escalation_level").eq("id", id).eq("account_id", ctx.accountId).maybeSingle();
    if (!current) return NextResponse.json({ error: "Incident not found." }, { status: 404 });
    let level = (current as { escalation_level: number }).escalation_level;
    const goal = body?.level === 2 || body?.level === 3 ? body.level : level + 1;
    if (goal <= level) return NextResponse.json({ error: "The incident is already at that level or higher." }, { status: 400 });

    let last: Record<string, unknown> = {};
    while (level < goal) {
      const { data, error } = await ctx.supabase.rpc("incident_escalate_manual", { p_incident_id: id });
      if (error) {
        if (level === (current as { escalation_level: number }).escalation_level) {
          const status = error.code === "22023" ? 400 : error.code === "42501" ? 403 : 500;
          return NextResponse.json({ error: error.message }, { status });
        }
        break;
      }
      last = (data ?? {}) as Record<string, unknown>;
      level = (last.escalation_level as number | undefined) ?? level + 1;

      // The people told are the roles the school's escalation rules name for the new level.
      await processIncidentEvent(id, "escalated");
    }

    // School webhook (Phase 3.6) — fire-and-forget.
    void (async () => {
      const { data } = await ctx.supabase.from("incidents").select("account_id, incident_number, created_at, incident_type, severity, status, escalation_level").eq("id", id).maybeSingle();
      if (!data) return;
      const inc = data as { account_id: string; incident_number: number; created_at: string; incident_type: string; severity: string; status: string; escalation_level: number };
      deliverSchoolWebhookEvent(inc.account_id, "incident.escalated", { incident_id: id, reference: incidentKey(inc), escalation_level: inc.escalation_level, category: inc.incident_type, severity: inc.severity });
    })();

    return NextResponse.json(last);
  } catch (err) {
    return toErrorResponse(err);
  }
}
