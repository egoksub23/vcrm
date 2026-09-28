// ============================================================
// POST /api/incidents/[id]/escalate — manual "Escalate now".
//
// Calls incident_escalate_manual() (migration 116/117), which does its
// own has_capability('incidents.manage') check, bumps the escalation
// level and inserts the in-app notifications. That RPC's jsonb return
// already lists exactly who it notified — this route just emails them
// (best-effort; SQL cannot make the HTTP call itself). Mirrors the
// escalation-cron route's shape.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { notifyIncidentEmail } from "@/lib/email/incident-notification-email";

interface EscalateNotified {
  user_id: string;
  incident_id: string;
  key: string;
  severity: string;
  title: string;
  level: number;
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability("incidents.manage");
    const { id } = await params;

    const { data, error } = await ctx.supabase.rpc("incident_escalate_manual", { p_incident_id: id });
    if (error) {
      const status = error.code === "22023" ? 400 : error.code === "42501" ? 403 : 500;
      return NextResponse.json({ error: error.message }, { status });
    }

    const appBaseUrl = process.env.NEXT_PUBLIC_SITE_URL;
    const notified = (data?.notified ?? []) as EscalateNotified[];
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

    return NextResponse.json(data ?? {});
  } catch (err) {
    return toErrorResponse(err);
  }
}
