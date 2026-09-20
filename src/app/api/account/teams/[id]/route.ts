// ============================================================
// /api/account/teams/[id]
//
//   PATCH  — update name / description / color. Admin+.
//   DELETE — delete the team. Admin+. Cascades team_members;
//            conversations.assigned_team_id is ON DELETE SET NULL
//            so in-flight conversations keep their assigned_agent_id
//            and just lose the team pointer.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import {
  HEX_COLOR_RE,
  validateTeamDescription,
  validateTeamName,
} from "@/lib/teams/validation";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireCapability("teams.manage");

    const limit = checkRateLimit(
      `admin:teamUpdate:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    const body = (await request.json().catch(() => null)) as
      | { name?: unknown; description?: unknown; color?: unknown }
      | null;

    const update: Record<string, unknown> = {};

    if (typeof body?.name === "string") {
      const trimmed = body.name.trim();
      const nameErr = validateTeamName(trimmed);
      if (nameErr) return NextResponse.json({ error: nameErr }, { status: 400 });
      update.name = trimmed;
    }

    if (typeof body?.description === "string") {
      const trimmed = body.description.trim();
      const descErr = validateTeamDescription(trimmed);
      if (descErr) return NextResponse.json({ error: descErr }, { status: 400 });
      update.description = trimmed === "" ? null : trimmed;
    }

    if (typeof body?.color === "string") {
      if (!HEX_COLOR_RE.test(body.color)) {
        return NextResponse.json(
          { error: "Color must be a hex value like #6366f1" },
          { status: 400 },
        );
      }
      update.color = body.color;
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
    }

    const { data, error } = await ctx.supabase
      .from("teams")
      .update(update)
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .select("id, account_id, name, description, color, created_at, updated_at")
      .maybeSingle();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json(
          { error: "A team with this name already exists" },
          { status: 409 },
        );
      }
      console.error("[PATCH /api/account/teams/[id]] update error:", error);
      return NextResponse.json({ error: "Failed to update team" }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }

    return NextResponse.json({ team: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireCapability("teams.manage");

    const limit = checkRateLimit(
      `admin:teamDelete:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;

    const { error, count } = await ctx.supabase
      .from("teams")
      .delete({ count: "exact" })
      .eq("id", id)
      .eq("account_id", ctx.accountId);

    if (error) {
      console.error("[DELETE /api/account/teams/[id]] delete error:", error);
      return NextResponse.json({ error: "Failed to delete team" }, { status: 500 });
    }
    if (!count) {
      return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
