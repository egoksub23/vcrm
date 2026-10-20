// ============================================================
// PUT /api/account/members/[userId]/addons   (members.change-role)
//
// Sets the WHOLE list of add-on roles a member holds (migration 191): the ones named are held afterwards, any other is taken away. Their base role does not
// change. The set_member_addon_roles function holds every rule: an admin rank, a target strictly below the caller, never the owner, never oneself, only this
// workspace's roles, and an add-on given only if the caller holds every permission in it (taking one away needs none).
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { isUuid, parseAddonRoleIds, rpcErrorToResponse } from "@/lib/auth/addon-roles";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

export async function PUT(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const ctx = await requireCapability("members.change-role");
    const limit = checkRateLimit(`admin:memberAddons:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;
    if (!isUuid(userId)) return NextResponse.json({ error: "Target user not found" }, { status: 404 });

    const body = (await request.json().catch(() => null)) as { addonRoleIds?: unknown } | null;
    if (!body || !("addonRoleIds" in body)) return NextResponse.json({ error: "'addonRoleIds' is required" }, { status: 400 });
    const ids = parseAddonRoleIds(body.addonRoleIds);
    if (!ids.ok) return NextResponse.json({ error: ids.error }, { status: 400 });

    const { data, error } = await ctx.supabase.rpc("set_member_addon_roles", { p_user_id: userId, p_addon_role_ids: ids.value });
    if (error) return rpcErrorToResponse(error, "save the add-on roles");
    return NextResponse.json({ ok: true, ...(data as Record<string, unknown>) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
