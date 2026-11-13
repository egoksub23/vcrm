// /api/incidents/[id]/void — an incident raised by mistake.
//   POST    { reason }  void it: it leaves the Dashboard, Reports and registers, its timers stop, and it stays on record with who, when and why.
//   DELETE              restore it (it stays Closed; reopen it from the status if it is real after all).
// Requires incidents.manage. Voiding does not tell anybody (it is not a "closed" event). Permanent deletion is a separate step for the Owner (DELETE /api/incidents/[id]).
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { createAdminPgDb } from "@/lib/postgres/db";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.manage");
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as { reason?: unknown } | null;
    const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 500) : "";
    if (reason.length < 3) return NextResponse.json({ error: "Say why it is being voided (a few words)." }, { status: 400 });

    const { data: cur } = await ctx.supabase.from("incidents").select("id, status, voided_at").eq("id", id).eq("account_id", ctx.accountId).maybeSingle();
    const row = cur as { id: string; status: string; voided_at: string | null } | null;
    if (!row) return NextResponse.json({ error: "Incident not found." }, { status: 404 });
    if (row.voided_at) return NextResponse.json({ error: "This incident is already voided." }, { status: 409 });

    const { error } = await ctx.supabase.from("incidents").update({ status: "closed", voided_at: new Date().toISOString(), voided_by: ctx.userId, void_reason: reason }).eq("id", id).eq("account_id", ctx.accountId);
    if (error) return NextResponse.json({ error: "Could not void the incident." }, { status: 500 });
    await createAdminPgDb().from("incident_activity").insert({ incident_id: id, account_id: ctx.accountId, actor_id: ctx.userId, event_type: "voided", to_value: reason });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.manage");
    const { id } = await params;
    const { data: cur } = await ctx.supabase.from("incidents").select("id, voided_at").eq("id", id).eq("account_id", ctx.accountId).maybeSingle();
    const row = cur as { id: string; voided_at: string | null } | null;
    if (!row) return NextResponse.json({ error: "Incident not found." }, { status: 404 });
    if (!row.voided_at) return NextResponse.json({ error: "This incident is not voided." }, { status: 409 });

    const { error } = await ctx.supabase.from("incidents").update({ voided_at: null, voided_by: null, void_reason: null }).eq("id", id).eq("account_id", ctx.accountId);
    if (error) return NextResponse.json({ error: "Could not restore the incident." }, { status: 500 });
    await createAdminPgDb().from("incident_activity").insert({ incident_id: id, account_id: ctx.accountId, actor_id: ctx.userId, event_type: "restored" });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
