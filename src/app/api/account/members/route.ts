// ============================================================
// GET /api/account/members
//
// Lists every member of the caller's account WITH every team they
// belong to, their last-active time and the open work assigned to them,
// in one database call (`list_team_members()`, migration 083): no
// per-person fetch. Any member can call it (the Team screen is shown to
// everyone who can open Settings; edit controls are gated separately).
//
// Field visibility
//   Email is returned only to admin+ callers (the function nulls it for
//   everyone else), mirroring "agent/viewer sees names only".
//
// Also returns how many capabilities each role holds right now (default
// plus this account's overrides) for the member panel's access summary.
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import {
  CAPABILITIES,
  overridesFromRows,
  resolveCapabilities,
  withAddonCapabilities,
} from "@/lib/auth/capabilities";
import type { AddonRoleRef } from "@/lib/auth/addon-roles";
import { ACCOUNT_ROLES, isAccountRole } from "@/lib/auth/roles";
import type { RosterMember, TeamRef } from "@/lib/teams/members";

interface RosterRow {
  user_id: string;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
  role: string;
  custom_role_id: string | null;
  custom_role_name: string | null;
  joined_at: string;
  last_active: string | null;
  teams: TeamRef[] | null;
  open_conversations: number | null;
  open_tickets: number | null;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const [rosterRes, overridesRes, customRolesRes, addonsRes] = await Promise.all([
      ctx.supabase.rpc("list_team_members"),
      ctx.supabase
        .from("role_capabilities")
        .select("role, capability, granted")
        .eq("account_id", ctx.accountId),
      ctx.supabase
        .from("account_roles")
        .select("id, base_role")
        .eq("account_id", ctx.accountId),
      // Add-on roles (migration 191) each person holds, with the permissions in them (for an honest count). A hint only: unreadable = none shown.
      ctx.supabase
        .from("member_addon_roles")
        .select("user_id, addon_role_id, account_addon_roles(name, account_addon_role_capabilities(capability))")
        .eq("account_id", ctx.accountId),
    ]);

    if (rosterRes.error) {
      console.error("[GET /api/account/members] fetch error:", rosterRes.error);
      return NextResponse.json(
        { error: "Failed to load members" },
        { status: 500 },
      );
    }

    // user id -> their add-on roles, and the permission keys those carry
    type AddonRow = {
      user_id: string;
      addon_role_id: string;
      account_addon_roles?: { name?: string; account_addon_role_capabilities?: { capability?: string }[] | null } | null;
    };
    const addonsByUser = new Map<string, AddonRoleRef[]>();
    const addonKeysByUser = new Map<string, string[]>();
    for (const a of addonsRes.error ? [] : ((addonsRes.data ?? []) as unknown as AddonRow[])) {
      const list = addonsByUser.get(a.user_id) ?? [];
      list.push({ id: a.addon_role_id, name: a.account_addon_roles?.name ?? "" });
      addonsByUser.set(a.user_id, list);
      const keys = addonKeysByUser.get(a.user_id) ?? [];
      for (const c of a.account_addon_roles?.account_addon_role_capabilities ?? []) if (typeof c.capability === "string") keys.push(c.capability);
      addonKeysByUser.set(a.user_id, keys);
    }

    const members: RosterMember[] = ((rosterRes.data ?? []) as RosterRow[]).flatMap(
      (row) => {
        // Defensive: the DB enum should never let an unknown role
        // through, but if a migration ever broadens the enum without
        // updating TS, skip the row rather than crash the page.
        if (!isAccountRole(row.role)) return [];
        return [
          {
            user_id: row.user_id,
            full_name: row.full_name ?? "",
            email: row.email,
            avatar_url: row.avatar_url,
            role: row.role,
            custom_role_id: row.custom_role_id,
            custom_role_name: row.custom_role_name,
            joined_at: row.joined_at,
            last_active: row.last_active,
            teams: Array.isArray(row.teams) ? row.teams : [],
            open_conversations: row.open_conversations ?? 0,
            open_tickets: row.open_tickets ?? 0,
            addon_roles: (addonsByUser.get(row.user_id) ?? []).sort((x, y) => x.name.localeCompare(y.name)),
          },
        ];
      },
    );

    // Overrides are a hint for the summary only: if they cannot be read
    // the counts fall back to the role defaults.
    const overrideRows = overridesRes.error ? [] : (overridesRes.data ?? []);
    const capabilityCounts: Record<string, number> = {};
    const roleSets: Record<string, Set<string>> = {};
    for (const role of ACCOUNT_ROLES) {
      const overrides = overridesFromRows(
        overrideRows.filter((r) => r.role === role),
      );
      roleSets[role] = resolveCapabilities(
        role,
        role === "owner" ? null : overrides,
      );
      capabilityCounts[role] = roleSets[role].size;
    }

    // Same idea per custom role (migration 112), keyed by id instead of
    // the literal role, for members whose access diverges from their
    // bare base tier.
    const customRoleRows = customRolesRes.error ? [] : (customRolesRes.data ?? []);
    const customRoleIds = customRoleRows.map((r) => r.id);
    const customOverridesRes =
      customRoleIds.length > 0
        ? await ctx.supabase
            .from("account_role_capabilities")
            .select("account_role_id, capability, granted")
            .in("account_role_id", customRoleIds)
        : { data: [] as { account_role_id: string; capability: string; granted: boolean }[], error: null };
    const customOverrideRows = customOverridesRes.error ? [] : (customOverridesRes.data ?? []);
    const customRoleCapabilityCounts: Record<string, number> = {};
    const customRoleSets: Record<string, Set<string>> = {};
    for (const role of customRoleRows) {
      if (!isAccountRole(role.base_role)) continue;
      const overrides = overridesFromRows(
        customOverrideRows
          .filter((r) => r.account_role_id === role.id)
          .map((r) => ({ capability: r.capability, granted: r.granted })),
      );
      customRoleSets[role.id] = resolveCapabilities(role.base_role, overrides);
      customRoleCapabilityCounts[role.id] = customRoleSets[role.id].size;
    }

    // For a person who holds add-on roles the count above (their base role's) understates what they can do: the real number is the base set plus the
    // add-ons', never above the base tier's floor. Sent only for those people.
    const effectiveCapabilityCounts: Record<string, number> = {};
    for (const m of members) {
      const keys = addonKeysByUser.get(m.user_id);
      if (!keys || keys.length === 0) continue;
      const base = (m.custom_role_id ? customRoleSets[m.custom_role_id] : undefined) ?? roleSets[m.role];
      if (base) effectiveCapabilityCounts[m.user_id] = withAddonCapabilities(base, m.role, keys).size;
    }

    return NextResponse.json({
      members,
      capabilityCounts,
      customRoleCapabilityCounts,
      effectiveCapabilityCounts,
      capabilityTotal: CAPABILITIES.length,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
