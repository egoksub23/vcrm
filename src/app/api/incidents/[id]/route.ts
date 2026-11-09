import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { processIncidentEvent } from "@/lib/incidents/platform/run";
import { checkMove } from "@/lib/incidents/platform/workflow-data";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

    // A status change may be held back by the school's requirements (a root cause written, every required step done, a role's approval ...).
    if (typeof body.status === "string") {
      const { data: current } = await ctx.supabase.from("incidents").select("id, account_id, status, root_cause, incident_lead_id").eq("id", id).eq("account_id", ctx.accountId).maybeSingle();
      if (!current) return NextResponse.json({ error: "Incident not found." }, { status: 404 });
      // The root cause or the lead may be set in the same request as the move; judge the incident as it will be.
      const after = { ...(current as { id: string; account_id: string; status: string; root_cause: string | null; incident_lead_id: string | null }) };
      if (typeof body.root_cause === "string" || body.root_cause === null) after.root_cause = body.root_cause as string | null;
      if (typeof body.incident_lead_id === "string" || body.incident_lead_id === null) after.incident_lead_id = body.incident_lead_id as string | null;
      const move = await checkMove({ incident: after, to: body.status, userId: ctx.userId });
      if (!move.ok) return NextResponse.json({ error: move.error, problems: move.problems }, { status: move.status });
    }

    const { error } = await ctx.supabase
      .from("incidents")
      .update(body)
      .eq("id", id)
      .eq("account_id", ctx.accountId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    // Closing an incident can trigger "tell the Principal" style rules.
    if (body.status === "closed") await processIncidentEvent(id, "closed");
    // Triage can raise the severity, change the category or add what the incident involves after it was raised. Run the "raised" rules again so a role that now
    // matches is told. A notice already sent is never sent twice (the outbox remembers it), so this only adds what is new.
    if (body.severity !== undefined || body.incident_type !== undefined || body.incident_flags !== undefined) await processIncidentEvent(id, "raised");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
