// ============================================================
// /api/account/teams/[id]/members/[userId]
//
//   DELETE — remove a member from this team. Admin+.
//
// `team_members` carries no `account_id` of its own (only `team_id`),
// so tenancy is enforced by first confirming the team belongs to the
// caller's account, then scoping the delete to that team.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  try {
    const ctx = await requireCapability("teams.manage");

    const limit = checkRateLimit(
      `admin:teamMemberRemove:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id: teamId, userId } = await params;

    const { data: team } = await ctx.supabase
      .from("teams")
      .select("id")
      .eq("id", teamId)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (!team) {
      return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }

    const { error, count } = await ctx.supabase
      .from("team_members")
      .delete({ count: "exact" })
      .eq("team_id", teamId)
      .eq("user_id", userId);

    if (error) {
      console.error(
        "[DELETE /api/account/teams/[id]/members/[userId]] delete error:",
        error,
      );
      return NextResponse.json(
        { error: "Failed to remove team member" },
        { status: 500 },
      );
    }
    if (!count) {
      return NextResponse.json(
        { error: "Member not found on this team" },
        { status: 404 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
