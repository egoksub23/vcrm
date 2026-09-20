// ============================================================
// GET /api/account/roles  (roles.manage)
//
// The matrix for the Roles & permissions screen: every role with its
// member count, effective capability set, the stored overrides and who
// changed each one. Also returns the EDITOR's own capability set and
// role so the screen can grey the switches the editor may not flip
// (mirrors the guardrails enforced inside `set_role_capabilities`).
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import {
  canEditRole,
  overridesFromRows,
  resolveCapabilities,
} from "@/lib/auth/capabilities";
import { ACCOUNT_ROLES, isAccountRole, type AccountRole } from "@/lib/auth/roles";

interface OverrideRow {
  role: string;
  capability: string;
  granted: boolean;
  changed_by: string | null;
  changed_at: string;
}

interface ProfileRow {
  user_id: string;
  full_name: string | null;
  email: string | null;
  account_role: string;
}

export interface RoleMatrixEntry {
  role: AccountRole;
  /** Members currently holding this role. */
  memberCount: number;
  /** True when the caller may edit this role. */
  editable: boolean;
  /** Effective capabilities (default + overrides). */
  effective: string[];
  /** Stored overrides: capability -> granted. */
  overrides: Record<string, boolean>;
  /** Who last changed each overridden capability. */
  changed: Record<
    string,
    { by: { id: string; name: string } | null; at: string }
  >;
}

export interface RoleMatrixResponse {
  /** The caller's role. */
  role: AccountRole;
  /** The caller's own effective capabilities. */
  editorCapabilities: string[];
  /** All four roles, highest first. */
  roles: RoleMatrixEntry[];
}

export async function GET() {
  try {
    const ctx = await requireCapability("roles.manage");

    const [overridesRes, profilesRes] = await Promise.all([
      ctx.supabase
        .from("role_capabilities")
        .select("role, capability, granted, changed_by, changed_at")
        .eq("account_id", ctx.accountId),
      ctx.supabase
        .from("profiles")
        .select("user_id, full_name, email, account_role")
        .eq("account_id", ctx.accountId),
    ]);

    if (overridesRes.error || profilesRes.error) {
      console.error(
        "[GET /api/account/roles] fetch error:",
        overridesRes.error ?? profilesRes.error,
      );
      return NextResponse.json(
        { error: "Failed to load roles" },
        { status: 500 },
      );
    }

    const overrideRows = (overridesRes.data ?? []) as OverrideRow[];
    const profiles = (profilesRes.data ?? []) as ProfileRow[];

    const nameOf = new Map<string, string>();
    const counts = new Map<string, number>();
    for (const p of profiles) {
      nameOf.set(p.user_id, p.full_name?.trim() || p.email || "");
      counts.set(p.account_role, (counts.get(p.account_role) ?? 0) + 1);
    }

    const roles: RoleMatrixEntry[] = [...ACCOUNT_ROLES]
      .reverse()
      .filter(isAccountRole)
      .map((role) => {
        const rows = overrideRows.filter((r) => r.role === role);
        const overrides = overridesFromRows(rows);
        const changed: RoleMatrixEntry["changed"] = {};
        for (const r of rows) {
          changed[r.capability] = {
            by: r.changed_by
              ? { id: r.changed_by, name: nameOf.get(r.changed_by) ?? "" }
              : null,
            at: r.changed_at,
          };
        }
        return {
          role,
          memberCount: counts.get(role) ?? 0,
          editable: canEditRole(ctx.role, role),
          effective: [...resolveCapabilities(role, overrides)].sort(),
          overrides: role === "owner" ? {} : overrides,
          changed: role === "owner" ? {} : changed,
        };
      });

    const body: RoleMatrixResponse = {
      role: ctx.role,
      editorCapabilities: [...ctx.capabilities].sort(),
      roles,
    };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
