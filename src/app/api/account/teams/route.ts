// ============================================================
// /api/account/teams
//
//   GET  — list every team in the caller's account, each with its
//          member roster (name/email/avatar joined from profiles) and
//          how many open conversations are assigned to the team.
//          Any member can call it (mirrors /api/account/members —
//          read is account-wide, write is admin+).
//   POST — create a team. Admin+.
//
// `team_members.user_id` has no FK to `profiles` (only to
// auth.users), so PostgREST can't embed the join — same reasoning
// as `getCurrentAccount`'s account lookup (issue #294): a schema-
// cache-dependent embed is one migration away from a flaky 500.
// Two manual round trips instead.
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, requireCapability, toErrorResponse } from "@/lib/auth/account";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import {
  HEX_COLOR_RE,
  TEAM_DEFAULT_COLOR,
  validateTeamDescription,
  validateTeamName,
} from "@/lib/teams/validation";
import type { Team, TeamMember } from "@/types";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const { data: teams, error: teamsErr } = await ctx.supabase
      .from("teams")
      .select("id, account_id, name, description, color, created_at, updated_at")
      .eq("account_id", ctx.accountId)
      .order("created_at", { ascending: true });

    if (teamsErr) {
      console.error("[GET /api/account/teams] fetch error:", teamsErr);
      return NextResponse.json({ error: "Failed to load teams" }, { status: 500 });
    }

    const teamIds = (teams ?? []).map((t) => t.id);
    const membersByTeam = new Map<string, TeamMember[]>();

    if (teamIds.length > 0) {
      const { data: memberRows, error: membersErr } = await ctx.supabase
        .from("team_members")
        .select("id, team_id, user_id, added_at, last_assigned_at")
        .in("team_id", teamIds);

      if (membersErr) {
        console.error("[GET /api/account/teams] members fetch error:", membersErr);
        return NextResponse.json({ error: "Failed to load team members" }, { status: 500 });
      }

      const userIds = Array.from(new Set((memberRows ?? []).map((m) => m.user_id)));
      const profileByUser = new Map<
        string,
        { full_name: string | null; email: string | null; avatar_url: string | null }
      >();

      if (userIds.length > 0) {
        const { data: profileRows } = await ctx.supabase
          .from("profiles")
          .select("user_id, full_name, email, avatar_url")
          .in("user_id", userIds);
        for (const p of profileRows ?? []) {
          profileByUser.set(p.user_id, p);
        }
      }

      for (const row of memberRows ?? []) {
        const profile = profileByUser.get(row.user_id);
        const member: TeamMember = {
          id: row.id,
          team_id: row.team_id,
          user_id: row.user_id,
          added_at: row.added_at,
          last_assigned_at: row.last_assigned_at,
          full_name: profile?.full_name ?? "",
          email: profile?.email ?? null,
          avatar_url: profile?.avatar_url ?? null,
        };
        const list = membersByTeam.get(row.team_id) ?? [];
        list.push(member);
        membersByTeam.set(row.team_id, list);
      }
    }

    // Open conversations per team (one grouped query, migration 083).
    // A failure only blanks the counts; the list itself still loads.
    const openByTeam = new Map<string, number>();
    const { data: countRows, error: countsErr } = await ctx.supabase.rpc(
      "team_open_conversation_counts",
    );
    if (countsErr) {
      console.error("[GET /api/account/teams] counts error:", countsErr);
    } else {
      for (const row of (countRows ?? []) as {
        team_id: string;
        open_conversations: number;
      }[]) {
        openByTeam.set(row.team_id, row.open_conversations);
      }
    }

    const result: Team[] = (teams ?? []).map((t) => ({
      ...t,
      members: membersByTeam.get(t.id) ?? [],
      open_conversations: openByTeam.get(t.id) ?? 0,
    }));

    return NextResponse.json({ teams: result });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("teams.manage");

    const limit = checkRateLimit(
      `admin:teamCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as
      | { name?: unknown; description?: unknown; color?: unknown }
      | null;

    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const nameErr = validateTeamName(name);
    if (nameErr) {
      return NextResponse.json({ error: nameErr }, { status: 400 });
    }

    let description: string | null = null;
    if (typeof body?.description === "string") {
      const trimmed = body.description.trim();
      const descErr = validateTeamDescription(trimmed);
      if (descErr) {
        return NextResponse.json({ error: descErr }, { status: 400 });
      }
      description = trimmed === "" ? null : trimmed;
    }

    let color = TEAM_DEFAULT_COLOR;
    if (typeof body?.color === "string" && HEX_COLOR_RE.test(body.color)) {
      color = body.color;
    }

    const { data, error } = await ctx.supabase
      .from("teams")
      .insert({ account_id: ctx.accountId, name, description, color })
      .select("id, account_id, name, description, color, created_at, updated_at")
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json(
          { error: "A team with this name already exists" },
          { status: 409 },
        );
      }
      console.error("[POST /api/account/teams] insert error:", error);
      return NextResponse.json({ error: "Failed to create team" }, { status: 500 });
    }

    return NextResponse.json({ team: { ...data, members: [] } }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
