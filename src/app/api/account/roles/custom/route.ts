// ============================================================
// GET  /api/account/roles/custom   (roles.manage)
// POST /api/account/roles/custom   (roles.manage)
//
// Custom roles (migration 112-114): named capability-set profiles
// pinned to one of the three non-owner base tiers. GET mirrors
// GET /api/account/roles' shape (RoleMatrixEntry) but for an
// account's custom roles instead of the 4 built-ins. POST creates one
// from scratch (source = a built-in role's CURRENT effective set in
// this account) or by duplicating another custom role, via the
// create_account_role RPC — the only write path, every guardrail
// (roles.manage, strictly-below-caller rank, can't grant what you
// don't hold) lives inside it.
// ============================================================

import { NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { canEditRole, overridesFromRows, resolveCapabilities } from "@/lib/auth/capabilities";
import { isAccountRole, roleRank, type AccountRole } from "@/lib/auth/roles";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

interface AccountRoleRow {
  id: string;
  name: string;
  base_role: AccountRole;
}

interface OverrideRow {
  account_role_id: string;
  capability: string;
  granted: boolean;
  changed_by: string | null;
  changed_at: string;
}

export interface CustomRoleEntry {
  id: string;
  name: string;
  baseRole: AccountRole;
  memberCount: number;
  editable: boolean;
  effective: string[];
  overrides: Record<string, boolean>;
  changed: Record<string, { by: { id: string; name: string } | null; at: string }>;
}

export interface CustomRoleListResponse {
  roles: CustomRoleEntry[];
}

function rpcErrorToResponse(err: PostgrestError): NextResponse {
  if (err.code === "42501") return NextResponse.json({ error: err.message }, { status: 403 });
  if (err.code === "23505") return NextResponse.json({ error: err.message }, { status: 409 });
  if (err.code === "22023") return NextResponse.json({ error: err.message }, { status: 400 });
  console.error("[account/roles/custom] unexpected RPC error:", err);
  return NextResponse.json({ error: "Failed to save the role" }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await requireCapability("roles.manage");

    const [rolesRes, profilesRes] = await Promise.all([
      ctx.supabase
        .from("account_roles")
        .select("id, name, base_role")
        .eq("account_id", ctx.accountId)
        .order("name"),
      ctx.supabase
        .from("profiles")
        .select("user_id, full_name, email, custom_role_id")
        .eq("account_id", ctx.accountId)
        .not("custom_role_id", "is", null),
    ]);

    if (rolesRes.error || profilesRes.error) {
      console.error("[GET /api/account/roles/custom] fetch error:", rolesRes.error ?? profilesRes.error);
      return NextResponse.json({ error: "Failed to load custom roles" }, { status: 500 });
    }
    const roleRows = (rolesRes.data ?? []) as AccountRoleRow[];

    // account_role_capabilities has no account_id column of its own, so
    // the override rows are fetched by role id once the roles above are
    // known (a second round trip, but only ever runs for this account's
    // own roles — no cross-account leak risk to weigh against it).
    const roleIds = roleRows.map((r) => r.id);
    const overridesRes =
      roleIds.length > 0
        ? await ctx.supabase
            .from("account_role_capabilities")
            .select("account_role_id, capability, granted, changed_by, changed_at")
            .in("account_role_id", roleIds)
        : { data: [] as OverrideRow[], error: null };
    if (overridesRes.error) {
      console.error("[GET /api/account/roles/custom] overrides fetch error:", overridesRes.error);
      return NextResponse.json({ error: "Failed to load custom roles" }, { status: 500 });
    }

    const overrideRows = (overridesRes.data ?? []) as OverrideRow[];
    const profiles = (profilesRes.data ?? []) as {
      user_id: string;
      full_name: string | null;
      email: string | null;
      custom_role_id: string | null;
    }[];

    const nameOf = new Map<string, string>();
    const counts = new Map<string, number>();
    for (const p of profiles) {
      nameOf.set(p.user_id, p.full_name?.trim() || p.email || "");
      if (p.custom_role_id) counts.set(p.custom_role_id, (counts.get(p.custom_role_id) ?? 0) + 1);
    }

    const roles: CustomRoleEntry[] = roleRows.map((r) => {
      const rows = overrideRows.filter((row) => row.account_role_id === r.id);
      const overrides = overridesFromRows(rows);
      const changed: CustomRoleEntry["changed"] = {};
      for (const row of rows) {
        changed[row.capability] = {
          by: row.changed_by ? { id: row.changed_by, name: nameOf.get(row.changed_by) ?? "" } : null,
          at: row.changed_at,
        };
      }
      return {
        id: r.id,
        name: r.name,
        baseRole: r.base_role,
        memberCount: counts.get(r.id) ?? 0,
        editable: canEditRole(ctx.role, r.base_role),
        effective: [...resolveCapabilities(r.base_role, overrides)].sort(),
        overrides,
        changed,
      };
    });

    return NextResponse.json({ roles }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("roles.manage");
    const limit = checkRateLimit(`admin:customRoleCreate:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as
      | { name?: unknown; baseRole?: unknown; source?: unknown }
      | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const baseRole = body?.baseRole;
    const source = body?.source as { kind?: unknown; role?: unknown; id?: unknown } | undefined;

    if (!name) {
      return NextResponse.json({ error: "Give the role a name" }, { status: 400 });
    }
    if (!isAccountRole(baseRole) || baseRole === "owner") {
      return NextResponse.json(
        { error: "'baseRole' must be one of admin, agent, viewer" },
        { status: 400 },
      );
    }
    if (roleRank(baseRole) >= roleRank(ctx.role)) {
      return NextResponse.json({ error: "You can only create roles below your own" }, { status: 403 });
    }
    if (!source || (source.kind !== "base" && source.kind !== "custom")) {
      return NextResponse.json(
        { error: "'source.kind' must be \"base\" or \"custom\"" },
        { status: 400 },
      );
    }
    if (source.kind === "base" && (!isAccountRole(source.role) || source.role === "owner")) {
      return NextResponse.json({ error: "'source.role' must be one of admin, agent, viewer" }, { status: 400 });
    }
    if (source.kind === "custom" && typeof source.id !== "string") {
      return NextResponse.json({ error: "'source.id' is required" }, { status: 400 });
    }

    const { data, error } = await ctx.supabase.rpc("create_account_role", {
      p_account_id: ctx.accountId,
      p_name: name,
      p_base_role: baseRole,
      p_source: source.kind === "base" ? { kind: "base", role: source.role } : { kind: "custom", id: source.id },
    });
    if (error) return rpcErrorToResponse(error);

    return NextResponse.json({ id: data as string }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
