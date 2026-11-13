// /api/incidents/setup/workflow — what must be true before an incident moves to a status.
//   GET  the requirements per status, whether moving back is allowed, and the roles that can approve.
//   PUT  { guards: [{ to_status, requires: { root_cause?, steps_done?, lead_assigned?, approval_role? } }], allow_backward? }  replaces them all.
// Requires incidents.configure.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { labelOf } from "@/lib/incidents/platform/roles";
import { loadGuards, STATUS_WORDS } from "@/lib/incidents/platform/workflow-data";
import { parseGuards } from "@/lib/incidents/platform/workflow";
import { ensureStarterRoles } from "@/lib/incidents/platform/setup-data";

async function rolesOf(ctx: Awaited<ReturnType<typeof requireCapability>>) {
  const { data } = await ctx.supabase.from("incident_roles").select("key, name, kind").eq("account_id", ctx.accountId).order("sort_order");
  return ((data ?? []) as { key: string; name: Record<string, string>; kind: string }[]).filter((r) => r.kind === "fixed").map((r) => ({ key: r.key, name: labelOf(r.name) }));
}

export async function GET() {
  try {
    const ctx = await requireCapability("incidents.configure");
    await ensureStarterRoles(ctx.accountId);
    const [{ guards, allowBackward }, roles] = await Promise.all([loadGuards(ctx.supabase, ctx.accountId), rolesOf(ctx)]);
    return NextResponse.json({ guards, allowBackward, roles, statuses: Object.entries(STATUS_WORDS).filter(([k]) => k !== "reported").map(([key, label]) => ({ key, label })) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const roles = await rolesOf(ctx);
    const parsed = parseGuards(await request.json().catch(() => null), roles.map((r) => r.key));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    const del = await ctx.supabase.from("incident_workflow_guards").delete().eq("account_id", ctx.accountId);
    if (del.error) return NextResponse.json({ error: "Could not save the requirements." }, { status: 500 });
    if (parsed.guards.length > 0) {
      const ins = await ctx.supabase.from("incident_workflow_guards").insert(parsed.guards.map((g) => ({ account_id: ctx.accountId, to_status: g.to_status, requires: g.requires, updated_by: ctx.userId })));
      if (ins.error) return NextResponse.json({ error: "Could not save the requirements." }, { status: 500 });
    }
    if (parsed.allowBackward !== null) {
      const up = await ctx.supabase.from("incident_settings").upsert({ account_id: ctx.accountId, workflow_allow_backward: parsed.allowBackward, updated_by: ctx.userId }, { onConflict: "account_id" });
      if (up.error) return NextResponse.json({ error: "Could not save the requirements." }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
