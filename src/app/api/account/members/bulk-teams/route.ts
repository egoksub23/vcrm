// ============================================================
// POST /api/account/members/bulk-teams   (teams.manage)
//
// Add several members to several teams, or remove them from those teams,
// in one call (change_team_members, migration 083). People and teams that
// are not in the caller's account are ignored silently.
//
// Body: { action: 'add' | 'remove', user_ids: string[], team_ids: string[] }
// Response: { ok: true, changed: number }   (rows added or removed)
//
// Static segment on purpose: it wins over `[userId]`.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { rpcErrorToResponse } from "@/lib/teams/member-rpc";
import { parseBulkTeamChange } from "@/lib/teams/team-ids";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("teams.manage");

    const limit = checkRateLimit(
      `admin:bulkTeams:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    const change = parseBulkTeamChange(body);
    if (!change.ok) {
      return NextResponse.json({ error: change.error }, { status: 400 });
    }

    const { data, error } = await ctx.supabase.rpc("change_team_members", {
      p_user_ids: change.userIds,
      p_team_ids: change.teamIds,
      p_action: change.action,
    });
    if (error) return rpcErrorToResponse(error, "Failed to update teams");

    const result = (data ?? {}) as { changed?: number };
    return NextResponse.json({ ok: true, changed: result.changed ?? 0 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
