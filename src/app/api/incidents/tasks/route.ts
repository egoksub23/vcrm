// GET /api/incidents/tasks — "My tasks": the open required steps that belong to the incident roles the signed-in person holds, plus steps with no role on
// incidents they lead. Read with the service connection (a role holder may not be able to read every incident), but only ever for the caller's own roles
// and school, and only the reference, category and severity of the incident come back, never its description.
import { NextResponse } from "next/server";

import { requireAnyCapability, toErrorResponse } from "@/lib/auth/account";
import { isMyTask } from "@/lib/incidents/platform/overview";
import { roleKeysForUser } from "@/lib/incidents/platform/setup-data";
import { createAdminPgDb } from "@/lib/postgres/db";

export async function GET() {
  try {
    const ctx = await requireAnyCapability(["menu.incidents"]);
    const admin = createAdminPgDb();
    const [myRoles, led] = await Promise.all([
      roleKeysForUser(admin, ctx.accountId, ctx.userId),
      admin.from("incidents").select("id").eq("account_id", ctx.accountId).eq("incident_lead_id", ctx.userId).neq("status", "closed"),
    ]);
    const leadOf = new Set(((led.data ?? []) as { id: string }[]).map((r) => r.id));

    const { data: steps } = await admin
      .from("incident_obligations")
      .select("id, incident_id, title, description, due_at, role_key, party")
      .eq("account_id", ctx.accountId)
      .eq("status", "open")
      .order("due_at", { ascending: true })
      .limit(500);
    const mine = ((steps ?? []) as { id: string; incident_id: string; title: string; description: string | null; due_at: string | null; role_key: string | null; party: string | null }[]).filter((s) =>
      isMyTask(s, myRoles, leadOf),
    );

    const incidentIds = [...new Set(mine.map((s) => s.incident_id))];
    const { data: incs } = incidentIds.length
      ? await admin.from("incidents").select("id, incident_number, created_at, incident_type, severity, status").in("id", incidentIds).neq("status", "closed")
      : { data: [] };
    const byId = new Map(((incs ?? []) as { id: string; incident_number: number; created_at: string; incident_type: string; severity: string }[]).map((i) => [i.id, i]));

    const now = Date.now();
    const tasks = mine
      .filter((s) => byId.has(s.incident_id))
      .map((s) => {
        const i = byId.get(s.incident_id)!;
        return {
          id: s.id,
          incidentId: s.incident_id,
          reference: `INC-${new Date(i.created_at).getFullYear()}-${i.incident_number}`,
          category: i.incident_type,
          severity: i.severity,
          title: s.title,
          description: s.description,
          roleKey: s.role_key,
          dueAt: s.due_at,
          overdue: s.due_at ? new Date(s.due_at).getTime() < now : false,
        };
      });
    return NextResponse.json({ tasks, roles: myRoles });
  } catch (err) {
    return toErrorResponse(err);
  }
}
