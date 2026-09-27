// ============================================================
// POST /api/account/roles/custom/[id]/duplicate  (roles.manage)
//
// Modeled on /api/automations/[id]/duplicate: fetch the original,
// insert a copy named "<name> (Copy)" (or the body's own `name`),
// resolving the copy's capability set from the source via
// create_account_role's source={kind:'custom', id}. No id-remapping
// graph needed here (unlike automation steps) — it's a capability-set
// diff, not a tree of child rows.
// ============================================================

import { NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { isAccountRole, roleRank } from "@/lib/auth/roles";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

type Params = { params: Promise<{ id: string }> };

function rpcErrorToResponse(err: PostgrestError): NextResponse {
  if (err.code === "42501") return NextResponse.json({ error: err.message }, { status: 403 });
  if (err.code === "23505") return NextResponse.json({ error: err.message }, { status: 409 });
  if (err.code === "22023") return NextResponse.json({ error: err.message }, { status: 400 });
  console.error("[account/roles/custom/[id]/duplicate] unexpected RPC error:", err);
  return NextResponse.json({ error: "Failed to duplicate the role" }, { status: 500 });
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("roles.manage");
    const limit = checkRateLimit(`admin:customRoleCreate:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    const { data: original, error: originalErr } = await ctx.supabase
      .from("account_roles")
      .select("id, name, base_role")
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (originalErr || !original) {
      return NextResponse.json({ error: "Role not found" }, { status: 404 });
    }
    if (!isAccountRole(original.base_role) || roleRank(original.base_role) >= roleRank(ctx.role)) {
      return NextResponse.json({ error: "You can only duplicate roles below your own" }, { status: 403 });
    }

    const body = (await request.json().catch(() => null)) as { name?: unknown; baseRole?: unknown } | null;
    const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim() : `${original.name} (Copy)`;
    const baseRole = isAccountRole(body?.baseRole) && body?.baseRole !== "owner" ? body.baseRole : original.base_role;
    if (roleRank(baseRole) >= roleRank(ctx.role)) {
      return NextResponse.json({ error: "You can only create roles below your own" }, { status: 403 });
    }

    const { data, error } = await ctx.supabase.rpc("create_account_role", {
      p_account_id: ctx.accountId,
      p_name: name,
      p_base_role: baseRole,
      p_source: { kind: "custom", id: original.id },
    });
    if (error) return rpcErrorToResponse(error);

    return NextResponse.json({ id: data as string }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
