// ============================================================
// /api/account/members/[userId]
//
//   PATCH  — change a member's role.   `members.change-role`.
//   DELETE — remove a member.          `members.remove`.
//            Optional `?reassign_to=<user id>` hands their open work to
//            someone instead of unassigning it. The Team screen uses
//            POST /api/account/members/[userId]/remove (same behaviour,
//            body instead of a query string); DELETE stays for older
//            callers.
//
// Both delegate to SECURITY DEFINER RPCs:
//   - set_member_role(p_user_id, p_new_role)          (018, 079)
//   - remove_account_member(p_user_id, p_reassign_to) (018, 079, 083)
//
// The RPCs do the *real* authorisation work: caller must hold the
// capability, the target must be in the caller's account, strictly below
// the caller's role, never the owner, never yourself. The TS layer here
// only forwards the call and maps Postgres SQLSTATEs to HTTP statuses.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { isAccountRole } from "@/lib/auth/roles";
import {
  removeMemberResponse,
  rpcErrorToResponse,
} from "@/lib/teams/member-rpc";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireCapability("members.change-role");

    const limit = checkRateLimit(
      `admin:memberRole:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    const body = (await request.json().catch(() => null)) as
      | { role?: unknown }
      | null;
    const role = body?.role;

    if (!isAccountRole(role)) {
      return NextResponse.json(
        { error: "'role' must be one of owner, admin, agent, viewer" },
        { status: 400 },
      );
    }

    // The RPC blocks promotion to / demotion from owner, but
    // surface the friendlier 400 before crossing the wire too.
    if (role === "owner") {
      return NextResponse.json(
        {
          error:
            "Use POST /api/account/transfer-ownership to promote a member to owner",
        },
        { status: 400 },
      );
    }

    const { error } = await ctx.supabase.rpc("set_member_role", {
      p_user_id: userId,
      p_new_role: role,
    });

    if (error) return rpcErrorToResponse(error);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireCapability("members.remove");

    const limit = checkRateLimit(
      `admin:memberRemove:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;
    const reassignTo = new URL(request.url).searchParams.get("reassign_to");

    return await removeMemberResponse(ctx, userId, reassignTo || null);
  } catch (err) {
    return toErrorResponse(err);
  }
}
