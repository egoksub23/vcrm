import { NextResponse } from "next/server";
import { getCurrentAccount, requireAnyCapability, toErrorResponse } from "@/lib/auth/account";
import { roleKeysForUser } from "@/lib/incidents/platform/setup-data";
import { createAdminPgDb } from "@/lib/postgres/db";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { data, error } = await ctx.supabase
      .from("incident_obligations")
      .select("*")
      .eq("incident_id", id)
      .eq("account_id", ctx.accountId)
      .order("due_at", { ascending: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ obligations: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireAnyCapability(["menu.incidents"]);
    const { id: incidentId } = await params;
    const body = (await request.json().catch(() => null)) as { oblId?: string; status?: string } | null;
    if (!body?.oblId || !body?.status) {
      return NextResponse.json({ error: "oblId and status required" }, { status: 400 });
    }
    if (!["open", "done", "not_applicable"].includes(body.status)) {
      return NextResponse.json({ error: "status must be open, done or not_applicable" }, { status: 400 });
    }

    // Who may tick a step: a manager, or a person who holds the role the step belongs to (the School nurse does not need to be a manager).
    // A person with only the role cannot read the step through row-level security, so it is looked up with the service connection.
    const admin = createAdminPgDb();
    const { data: step } = await admin
      .from("incident_obligations")
      .select("id, role_key")
      .eq("id", body.oblId)
      .eq("incident_id", incidentId)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (!step) return NextResponse.json({ error: "not found" }, { status: 404 });

    const isManager = ctx.capabilities.has("incidents.manage");
    if (!isManager) {
      const roleKey = (step as { role_key: string | null }).role_key;
      const mine = roleKey ? await roleKeysForUser(admin, ctx.accountId, ctx.userId) : [];
      if (!roleKey || !mine.includes(roleKey)) {
        return NextResponse.json({ error: "You do not hold the role this step belongs to." }, { status: 403 });
      }
    }

    // The database trigger stamps who completed it from the signed-in user, so a manager writes as themselves; a role holder is written with the
    // service connection and the stamp is set here.
    const patch: Record<string, unknown> = { status: body.status };
    const writer = isManager ? ctx.supabase : admin;
    if (!isManager) {
      patch.completed_by = body.status === "done" ? ctx.userId : null;
    }
    const { data, error } = await writer
      .from("incident_obligations")
      .update(patch)
      .eq("id", body.oblId)
      .eq("incident_id", incidentId)
      .eq("account_id", ctx.accountId)
      .select("*")
      .single();
    if (error || !data) return NextResponse.json({ error: error?.message ?? "not found" }, { status: 500 });
    return NextResponse.json({ obligation: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
