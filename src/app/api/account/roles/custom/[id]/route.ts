// ============================================================
// GET    /api/account/roles/custom/[id]  (roles.manage)
// PUT    /api/account/roles/custom/[id]  (roles.manage)
// DELETE /api/account/roles/custom/[id]  (roles.manage)
//
// One custom role's matrix entry, and the two write actions. PUT is a
// thin wrapper over set_account_role_capabilities (same body/guardrail
// shape as PUT /api/account/roles/[role]); DELETE wraps
// delete_account_role and reports how many members were demoted to
// their bare base tier.
// ============================================================

import { NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { canEditRole, isCapabilityKey, overridesFromRows, resolveCapabilities } from "@/lib/auth/capabilities";
import type { AccountRole } from "@/lib/auth/roles";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import type { CustomRoleEntry } from "../route";

type Params = { params: Promise<{ id: string }> };

function rpcErrorToResponse(err: PostgrestError): NextResponse {
  if (err.code === "42501") return NextResponse.json({ error: err.message }, { status: 403 });
  if (err.code === "22023") return NextResponse.json({ error: err.message }, { status: 400 });
  console.error("[account/roles/custom/[id]] unexpected RPC error:", err);
  return NextResponse.json({ error: "Failed to save the role" }, { status: 500 });
}

async function loadEntry(
  ctx: Awaited<ReturnType<typeof requireCapability>>,
  id: string,
): Promise<CustomRoleEntry | null> {
  const { data: role, error: roleErr } = await ctx.supabase
    .from("account_roles")
    .select("id, name, base_role")
    .eq("id", id)
    .eq("account_id", ctx.accountId)
    .maybeSingle();
  if (roleErr || !role) return null;

  const [overridesRes, membersRes] = await Promise.all([
    ctx.supabase
      .from("account_role_capabilities")
      .select("capability, granted, changed_by, changed_at")
      .eq("account_role_id", id),
    ctx.supabase.from("profiles").select("user_id, full_name, email").eq("custom_role_id", id),
  ]);
  const rows = (overridesRes.data ?? []) as {
    capability: string;
    granted: boolean;
    changed_by: string | null;
    changed_at: string;
  }[];
  const members = (membersRes.data ?? []) as { user_id: string; full_name: string | null; email: string | null }[];
  const nameOf = new Map(members.map((m) => [m.user_id, m.full_name?.trim() || m.email || ""]));

  const overrides = overridesFromRows(rows);
  const changed: CustomRoleEntry["changed"] = {};
  for (const r of rows) {
    changed[r.capability] = {
      by: r.changed_by ? { id: r.changed_by, name: nameOf.get(r.changed_by) ?? "" } : null,
      at: r.changed_at,
    };
  }

  return {
    id: role.id,
    name: role.name,
    baseRole: role.base_role as AccountRole,
    memberCount: members.length,
    editable: canEditRole(ctx.role, role.base_role as AccountRole),
    effective: [...resolveCapabilities(role.base_role as AccountRole, overrides)].sort(),
    overrides,
    changed,
  };
}

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("roles.manage");
    const { id } = await params;
    const entry = await loadEntry(ctx, id);
    if (!entry) return NextResponse.json({ error: "Role not found" }, { status: 404 });
    return NextResponse.json(entry, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("roles.manage");
    const limit = checkRateLimit(`admin:customRoleCapabilities:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    const body = (await request.json().catch(() => null)) as { changes?: unknown } | null;
    const changes = body?.changes;
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
      return NextResponse.json(
        { error: "'changes' must be an object of capability to true, false or null" },
        { status: 400 },
      );
    }
    const entries = Object.entries(changes as Record<string, unknown>);
    if (entries.length === 0) return NextResponse.json({ ok: true, changed: 0 });
    for (const [cap, value] of entries) {
      if (!isCapabilityKey(cap)) {
        return NextResponse.json({ error: `Unknown capability: ${cap}` }, { status: 400 });
      }
      if (value !== true && value !== false && value !== null) {
        return NextResponse.json({ error: `Capability ${cap} must be set to true, false or null` }, { status: 400 });
      }
    }

    const { data, error } = await ctx.supabase.rpc("set_account_role_capabilities", {
      target_account_role_id: id,
      changes,
    });
    if (error) return rpcErrorToResponse(error);

    const changed = data && typeof data === "object" && "changed" in data ? Number((data as { changed: unknown }).changed) : 0;
    return NextResponse.json({ ok: true, changed });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("roles.manage");
    const limit = checkRateLimit(`admin:customRoleDelete:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    const { data, error } = await ctx.supabase.rpc("delete_account_role", { target_account_role_id: id });
    if (error) return rpcErrorToResponse(error);

    const demoted =
      data && typeof data === "object" && "demoted_members" in data
        ? Number((data as { demoted_members: unknown }).demoted_members)
        : 0;
    return NextResponse.json({ ok: true, demotedMembers: demoted });
  } catch (err) {
    return toErrorResponse(err);
  }
}
