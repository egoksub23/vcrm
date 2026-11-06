// PATCH /api/incidents/setup/roles/[id] — rename, describe, or change who is told (everyone, or the first available).
// DELETE removes a role the school added. Built-in roles cannot be deleted, and a role that a switched-on rule tells cannot either.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { parseRole } from "@/lib/incidents/platform/input";
import { rolesUsedBy } from "@/lib/incidents/platform/setup-data";
import type { IncidentRule } from "@/lib/incidents/platform/rules";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const { id } = await params;
    const parsed = parseRole(await request.json().catch(() => null), true);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    const patch: Record<string, unknown> = {};
    if (parsed.value.name !== undefined) {
      // Only the English label changes here; other languages stay as they are.
      const { data: cur } = await ctx.supabase.from("incident_roles").select("name").eq("id", id).eq("account_id", ctx.accountId).maybeSingle();
      if (!cur) return NextResponse.json({ error: "Role not found." }, { status: 404 });
      patch.name = { ...(cur as { name: Record<string, string> }).name, en: parsed.value.name };
    }
    if (parsed.value.description !== undefined) patch.description = parsed.value.description;
    if (parsed.value.notify_mode !== undefined) patch.notify_mode = parsed.value.notify_mode;
    if (Object.keys(patch).length === 0) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });

    const { data, error } = await ctx.supabase.from("incident_roles").update(patch).eq("id", id).eq("account_id", ctx.accountId).select("*").maybeSingle();
    if (error) return NextResponse.json({ error: "Could not save the changes." }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Role not found." }, { status: 404 });
    return NextResponse.json({ role: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const { id } = await params;
    const { data: role } = await ctx.supabase.from("incident_roles").select("id, key, is_system").eq("id", id).eq("account_id", ctx.accountId).maybeSingle();
    const r = role as { id: string; key: string; is_system: boolean } | null;
    if (!r) return NextResponse.json({ error: "Role not found." }, { status: 404 });
    if (r.is_system) return NextResponse.json({ error: "Built-in roles cannot be deleted. Remove the people from the role instead." }, { status: 400 });

    const { data: rules } = await ctx.supabase.from("incident_rules").select("actions, enabled").eq("account_id", ctx.accountId);
    if ((rolesUsedBy((rules ?? []) as Pick<IncidentRule, "actions" | "enabled">[]).get(r.key) ?? 0) > 0) {
      return NextResponse.json({ error: "A rule that is switched on still tells this role. Change or switch off that rule first." }, { status: 409 });
    }
    const { error } = await ctx.supabase.from("incident_roles").delete().eq("id", id).eq("account_id", ctx.accountId);
    if (error) return NextResponse.json({ error: "Could not delete the role." }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
