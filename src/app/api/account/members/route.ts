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
} from "@/lib/auth/capabilities";
import { ACCOUNT_ROLES, isAccountRole } from "@/lib/auth/roles";
import type { RosterMember, TeamRef } from "@/lib/teams/members";

interface RosterRow {
  user_id: string;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
  role: string;
  joined_at: string;
  last_active: string | null;
  teams: TeamRef[] | null;
  open_conversations: number | null;
  open_tickets: number | null;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const [rosterRes, overridesRes] = await Promise.all([
      ctx.supabase.rpc("list_team_members"),
      ctx.supabase
        .from("role_capabilities")
        .select("role, capability, granted")
        .eq("account_id", ctx.accountId),
    ]);

    if (rosterRes.error) {
      console.error("[GET /api/account/members] fetch error:", rosterRes.error);
      return NextResponse.json(
        { error: "Failed to load members" },
        { status: 500 },
      );
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
            joined_at: row.joined_at,
            last_active: row.last_active,
            teams: Array.isArray(row.teams) ? row.teams : [],
            open_conversations: row.open_conversations ?? 0,
            open_tickets: row.open_tickets ?? 0,
          },
        ];
      },
    );

    // Overrides are a hint for the summary only: if they cannot be read
    // the counts fall back to the role defaults.
    const overrideRows = overridesRes.error ? [] : (overridesRes.data ?? []);
    const capabilityCounts: Record<string, number> = {};
    for (const role of ACCOUNT_ROLES) {
      const overrides = overridesFromRows(
        overrideRows.filter((r) => r.role === role),
      );
      capabilityCounts[role] = resolveCapabilities(
        role,
        role === "owner" ? null : overrides,
      ).size;
    }

    return NextResponse.json({
      members,
      capabilityCounts,
      capabilityTotal: CAPABILITIES.length,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
