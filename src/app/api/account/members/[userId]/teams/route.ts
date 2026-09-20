// ============================================================
// PUT /api/account/members/[userId]/teams   (teams.manage)
//
// Set the COMPLETE list of teams a member belongs to. The database
// (set_member_teams, migration 083) applies the difference atomically:
// teams not in the list are left, teams in it are joined, and any id that
// is not a team of the caller's account is ignored silently. The audit
// trigger logs each add / remove.
//
// Body: { team_ids: string[] }   (an empty list clears every team)
// Response: { ok: true, added: number, removed: number }
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { rpcErrorToResponse } from "@/lib/teams/member-rpc";
import { isUuid, parseUuidList } from "@/lib/teams/team-ids";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireCapability("teams.manage");

    const limit = checkRateLimit(
      `admin:memberTeams:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;
    if (!isUuid(userId)) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }

    const body = (await request.json().catch(() => null)) as
      | { team_ids?: unknown }
      | null;
    if (!body || !Array.isArray(body.team_ids)) {
      return NextResponse.json(
        { error: "'team_ids' must be an array of team ids" },
        { status: 400 },
      );
    }
    const teams = parseUuidList(body.team_ids, "team_ids");
    if (!teams.ok) {
      return NextResponse.json({ error: teams.error }, { status: 400 });
    }

    const { data, error } = await ctx.supabase.rpc("set_member_teams", {
      p_user_id: userId,
      p_team_ids: teams.ids,
    });
    if (error) return rpcErrorToResponse(error, "Failed to update teams");

    const result = (data ?? {}) as { added?: number; removed?: number };
    return NextResponse.json({
      ok: true,
      added: result.added ?? 0,
      removed: result.removed ?? 0,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
