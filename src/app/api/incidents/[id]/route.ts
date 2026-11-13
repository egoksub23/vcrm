import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { parseAmend } from "@/lib/incidents/platform/amend";
import { deleteIncidentForGood } from "@/lib/incidents/platform/delete-data";
import { processIncidentEvent } from "@/lib/incidents/platform/run";
import { deliverSchoolWebhookEvent } from "@/lib/incidents/platform/school-webhooks";
import { incidentKey } from "@/lib/incidents/types";
import { checkMove } from "@/lib/incidents/platform/workflow-data";
import { loadStatusOptions } from "@/lib/incidents/platform/statuses-data";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

    // A school's own status (migration 226) counts as one of the six base statuses: that base is what is stored in `status`, and the choice in `status_key`.
    // Moving to a status without naming one of the school's own (a board drag, an older client) means the base status itself.
    if (typeof body.status_key === "string") {
      const options = await loadStatusOptions(ctx.supabase, ctx.accountId);
      const chosen = options.find((o) => o.key === body.status_key && o.active);
      if (!chosen) return NextResponse.json({ error: "That status is not available." }, { status: 400 });
      body.status = chosen.base;
      body.status_key = chosen.builtin ? null : chosen.key;
    } else if (typeof body.status === "string" && body.status_key === undefined) {
      body.status_key = null;
    }

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

    // Amending the title or description: checked here, and written to the audit trail (with the reason, once the incident is closed) by the database.
    if (body.title !== undefined || body.description !== undefined) {
      const { data: now } = await ctx.supabase.from("incidents").select("status").eq("id", id).eq("account_id", ctx.accountId).maybeSingle();
      if (!now) return NextResponse.json({ error: "Incident not found." }, { status: 404 });
      const amend = parseAmend(body, (now as { status: string }).status);
      if (!amend.ok) return NextResponse.json({ error: amend.error }, { status: 400 });
      delete body.title;
      delete body.description;
      delete body.amend_reason;
      Object.assign(body, amend.patch);
    } else {
      delete body.amend_reason;
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

    // School webhooks (Phase 3.6) — fire-and-forget on status changes.
    if (typeof body.status === "string") {
      void (async () => {
        const db = ctx.supabase;
        const { data } = await db.from("incidents").select("account_id, incident_number, created_at, incident_type, severity, status").eq("id", id).maybeSingle();
        if (!data) return;
        const inc = data as { account_id: string; incident_number: number; created_at: string; incident_type: string; severity: string; status: string };
        const event = inc.status === "closed" ? "incident.closed" : "incident.status_changed";
        deliverSchoolWebhookEvent(inc.account_id, event, { incident_id: id, reference: incidentKey(inc), category: inc.incident_type, severity: inc.severity, status: inc.status });
      })();
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

// DELETE /api/incidents/[id] — delete a voided incident for good. The school's Owner only. Body: { confirm: "INC-2026-9" } (the reference, typed).
export async function DELETE(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    if (ctx.role !== "owner") return NextResponse.json({ error: "Only the school's Owner can delete an incident for good." }, { status: 403 });
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as { confirm?: unknown } | null;
    const result = await deleteIncidentForGood({ accountId: ctx.accountId, incidentId: id, userId: ctx.userId, confirm: typeof body?.confirm === "string" ? body.confirm : "" });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, reference: result.reference, filesRemoved: result.filesRemoved });
  } catch (err) {
    return toErrorResponse(err);
  }
}
