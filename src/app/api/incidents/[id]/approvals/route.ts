// /api/incidents/[id]/approvals — a role's yes or no on an incident.
//   GET   the approvals asked for on this incident, and which of them the signed-in person may answer (they hold the role).
//   POST  { decision: "approved" | "rejected", note? }  answer the approvals waiting on roles the person holds.
// A manager who does not hold the role cannot answer for it.
import { NextResponse } from "next/server";

import { requireAnyCapability, toErrorResponse } from "@/lib/auth/account";
import { roleKeysForUser } from "@/lib/incidents/platform/setup-data";
import { loadApprovals } from "@/lib/incidents/platform/workflow-data";
import { labelOf } from "@/lib/incidents/platform/roles";
import { createAdminPgDb } from "@/lib/postgres/db";

type Params = { params: Promise<{ id: string }> };

async function visibleTo(ctx: Awaited<ReturnType<typeof requireAnyCapability>>, incidentId: string, mine: string[]): Promise<boolean> {
  if (ctx.capabilities.has("incidents.manage")) return true;
  // A role holder can see the approvals on an incident when one is waiting on (or was asked of) a role they hold.
  const approvals = await loadApprovals(createAdminPgDb(), incidentId, ctx.accountId);
  return approvals.some((a) => mine.includes(a.role_key));
}

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await requireAnyCapability(["menu.incidents"]);
    const { id } = await params;
    const admin = createAdminPgDb();
    const mine = await roleKeysForUser(admin, ctx.accountId, ctx.userId);
    if (!(await visibleTo(ctx, id, mine))) return NextResponse.json({ approvals: [], canDecide: [] });
    const [approvals, roles] = await Promise.all([loadApprovals(admin, id, ctx.accountId), admin.from("incident_roles").select("key, name").eq("account_id", ctx.accountId)]);
    const names = new Map(((roles.data ?? []) as { key: string; name: Record<string, string> }[]).map((r) => [r.key, labelOf(r.name)]));
    return NextResponse.json({
      approvals: approvals.map((a) => ({ ...a, role_name: names.get(a.role_key) ?? a.role_key })),
      canDecide: approvals.filter((a) => a.decision === null && mine.includes(a.role_key)).map((a) => a.id),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await requireAnyCapability(["menu.incidents"]);
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as { decision?: unknown; note?: unknown } | null;
    if (body?.decision !== "approved" && body?.decision !== "rejected") return NextResponse.json({ error: "Choose approve or reject." }, { status: 400 });
    const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 500) : null;
    if (body.decision === "rejected" && !note) return NextResponse.json({ error: "Say why you are not approving, so it can be put right." }, { status: 400 });

    const admin = createAdminPgDb();
    const mine = await roleKeysForUser(admin, ctx.accountId, ctx.userId);
    const waiting = (await loadApprovals(admin, id, ctx.accountId)).filter((a) => a.decision === null && mine.includes(a.role_key));
    if (waiting.length === 0) return NextResponse.json({ error: "Nothing is waiting for your approval on this incident." }, { status: 404 });

    const { error } = await admin
      .from("incident_approvals")
      .update({ decision: body.decision, decided_by: ctx.userId, decided_at: new Date().toISOString(), note })
      .in("id", waiting.map((a) => a.id))
      .is("decision", null);
    if (error) return NextResponse.json({ error: "Could not record your answer." }, { status: 500 });
    return NextResponse.json({ ok: true, answered: waiting.length });
  } catch (err) {
    return toErrorResponse(err);
  }
}
