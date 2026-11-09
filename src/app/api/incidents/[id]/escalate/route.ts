// ============================================================
// POST /api/incidents/[id]/escalate — manual "Escalate now". Body (optional): { level: 2 | 3 } to go straight to a level; without it the level goes up by one.
//
// Calls incident_escalate_manual() (migrations 116/117/122/222), which does its own has_capability('incidents.manage') check, bumps the escalation level one
// step and records it. For a school with no rule for the moment of escalation, that call also inserts the in-app notifications and its jsonb return lists
// exactly who it notified, so this route emails them (best-effort; SQL cannot make the HTTP call itself). For a school with such a rule, the rule's roles are
// told instead (processIncidentEvent), once for each level passed through. Mirrors the escalation-cron route's shape.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { notifyIncidentEmail } from "@/lib/email/incident-notification-email";
import { processIncidentEvent } from "@/lib/incidents/platform/run";

interface EscalateNotified {
  user_id: string;
  incident_id: string;
  key: string;
  severity: string;
  title: string;
  level: number;
}

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

    const appBaseUrl = process.env.NEXT_PUBLIC_SITE_URL;
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

      const notified = ((last as { notified?: EscalateNotified[] }).notified ?? []) as EscalateNotified[];
      if (appBaseUrl && notified.length > 0) {
        await Promise.allSettled(
          notified.map((n) =>
            notifyIncidentEmail({
              userIds: [n.user_id],
              kind: "escalated",
              key: n.key,
              title: n.title,
              severity: n.severity,
              detail: `Manually escalated to level ${n.level}.`,
              incidentId: n.incident_id,
              appBaseUrl,
            }),
          ),
        );
      }
      // A school that writes a rule for the moment of escalation tells people through its roles (the SQL above then leaves the old name list out).
      await processIncidentEvent(id, "escalated");
    }

    return NextResponse.json(last);
  } catch (err) {
    return toErrorResponse(err);
  }
}
