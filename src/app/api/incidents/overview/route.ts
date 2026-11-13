// GET /api/incidents/overview — the counts and the "needs action now" list for the Overview page. Everything is read as the signed-in person, so row-level
// security decides what they see: managers see the whole school, a reporter sees only what they reported.
import { NextResponse } from "next/server";

import { requireAnyCapability, toErrorResponse } from "@/lib/auth/account";
import { buildOverview, type OverviewAck, type OverviewIncident, type OverviewStep } from "@/lib/incidents/platform/overview";
import { loadActiveTemplate } from "@/lib/incidents/platform/setup-data";

export async function GET() {
  try {
    const ctx = await requireAnyCapability(["menu.incidents"]);
    const since = new Date(Date.now() - 180 * 86_400_000).toISOString();
    const [incidents, steps, ack, template] = await Promise.all([
      ctx.supabase
        .from("incidents")
        .select("id, incident_number, created_at, title, incident_type, severity, status")
        .eq("account_id", ctx.accountId)
        .is("voided_at", null)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(1000),
      ctx.supabase.from("incident_obligations").select("id, incident_id, title, due_at, role_key").eq("account_id", ctx.accountId).eq("status", "open").not("due_at", "is", null).limit(1000),
      ctx.supabase.from("incident_ack_state").select("incident_id, first_ask_at, acknowledged").eq("account_id", ctx.accountId).limit(1000),
      loadActiveTemplate(ctx.supabase, ctx.accountId),
    ]);
    if (incidents.error) return NextResponse.json({ error: "Could not load the overview." }, { status: 500 });

    const overview = buildOverview({
      incidents: (incidents.data ?? []) as OverviewIncident[],
      steps: (steps.data ?? []) as OverviewStep[],
      ack: (ack.data ?? []) as OverviewAck[],
      categories: (template?.categories ?? []).map((c) => ({ code: c.code, name: c.name })),
      now: new Date(),
    });
    return NextResponse.json({
      overview,
      categories: Object.fromEntries((template?.categories ?? []).map((c) => [c.code, c.name])),
      severities: Object.fromEntries((template?.severities ?? []).map((s) => [s.slug, s.label])),
      canManage: ctx.capabilities.has("incidents.manage"),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
