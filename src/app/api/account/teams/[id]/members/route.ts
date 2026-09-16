// ============================================================
// /api/account/teams/[id]/members
//
//   POST — add an existing account member to this team. Admin+.
//
// The candidate must already be a member of the caller's account —
// a team can't hold someone who isn't even a teammate. RLS on
// `team_members` would also block a cross-account insert, but a
// clear 400/404 beats a generic RLS-denied 500.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import type { TeamMember } from "@/types";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `admin:teamMemberAdd:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id: teamId } = await params;
    const body = (await request.json().catch(() => null)) as
      | { user_id?: unknown }
      | null;
    const userId = typeof body?.user_id === "string" ? body.user_id : null;
    if (!userId) {
      return NextResponse.json({ error: "'user_id' is required" }, { status: 400 });
    }

    const { data: team } = await ctx.supabase
      .from("teams")
      .select("id")
      .eq("id", teamId)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (!team) {
      return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }

    const { data: profile } = await ctx.supabase
      .from("profiles")
      .select("user_id, full_name, email, avatar_url")
      .eq("user_id", userId)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (!profile) {
      return NextResponse.json(
        { error: "That user is not a member of this account" },
        { status: 400 },
      );
    }

    const { data, error } = await ctx.supabase
      .from("team_members")
      .insert({ team_id: teamId, user_id: userId })
      .select("id, team_id, user_id, added_at, last_assigned_at")
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json(
          { error: "That user is already on this team" },
          { status: 409 },
        );
      }
      console.error("[POST /api/account/teams/[id]/members] insert error:", error);
      return NextResponse.json(
        { error: "Failed to add team member" },
        { status: 500 },
      );
    }

    const member: TeamMember = {
      ...data,
      full_name: profile.full_name ?? "",
      email: profile.email,
      avatar_url: profile.avatar_url,
    };

    return NextResponse.json({ member }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
