// ============================================================
// PUT /api/account/roles/[role]  (roles.manage)
//
// Body: { changes: { "<capability>": true | false | null } }
//   true = grant, false = revoke, null = reset to the default.
//
// A thin wrapper over the `set_role_capabilities` RPC, which is the
// ONLY write path and enforces every guardrail (edit only roles
// strictly below your own, never grant what you do not hold, owner
// untouchable, viewer never gets a write capability, all-or-nothing,
// change log). The checks here only give friendlier early errors.
// ============================================================

import { NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { canEditRole, isCapabilityKey } from "@/lib/auth/capabilities";
import { isAccountRole } from "@/lib/auth/roles";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

function rpcErrorToResponse(err: PostgrestError): NextResponse {
  if (err.code === "42501") {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err.code === "22023") {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  console.error("[PUT /api/account/roles] unexpected RPC error:", err);
  return NextResponse.json(
    { error: "Failed to update role permissions" },
    { status: 500 },
  );
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ role: string }> },
) {
  try {
    const ctx = await requireCapability("roles.manage");

    const limit = checkRateLimit(
      `admin:roleCapabilities:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { role } = await params;
    if (!isAccountRole(role)) {
      return NextResponse.json(
        { error: "'role' must be one of owner, admin, agent, viewer" },
        { status: 400 },
      );
    }
    if (role === "owner") {
      return NextResponse.json(
        { error: "The Owner role always has full access and cannot be edited" },
        { status: 403 },
      );
    }
    if (!canEditRole(ctx.role, role)) {
      return NextResponse.json(
        { error: "You can only edit roles below your own" },
        { status: 403 },
      );
    }

    const body = (await request.json().catch(() => null)) as
      | { changes?: unknown }
      | null;
    const changes = body?.changes;
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
      return NextResponse.json(
        { error: "'changes' must be an object of capability to true, false or null" },
        { status: 400 },
      );
    }
    const entries = Object.entries(changes as Record<string, unknown>);
    if (entries.length === 0) {
      return NextResponse.json({ ok: true, changed: 0 });
    }
    for (const [cap, value] of entries) {
      if (!isCapabilityKey(cap)) {
        return NextResponse.json(
          { error: `Unknown capability: ${cap}` },
          { status: 400 },
        );
      }
      if (value !== true && value !== false && value !== null) {
        return NextResponse.json(
          { error: `Capability ${cap} must be set to true, false or null` },
          { status: 400 },
        );
      }
    }

    const { data, error } = await ctx.supabase.rpc("set_role_capabilities", {
      target_account_id: ctx.accountId,
      target_role: role,
      changes,
    });
    if (error) return rpcErrorToResponse(error);

    const changed =
      data && typeof data === "object" && "changed" in data
        ? Number((data as { changed: unknown }).changed)
        : 0;
    return NextResponse.json({ ok: true, changed });
  } catch (err) {
    return toErrorResponse(err);
  }
}
