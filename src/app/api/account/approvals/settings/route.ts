// ============================================================
// GET/PATCH /api/account/approvals/settings
//
// The "Agents need approval for" switch group on Settings > Approvals.
//
//   GET    (approvals.review)  { snippets, tags, canEdit }
//            snippets.needsApproval  the Agent role lacks snippets.manage
//            tags.needsApproval      the Agent role lacks tags.manage (always
//                                     the case today: Agents cannot be given
//                                     it, so tags and labels always go
//                                     through review; the switch is locked)
//            canEdit                 the caller may flip the snippets switch
//   PATCH  (roles.manage)      { snippets: boolean }
//            true  = Agents need approval for snippets (revoke snippets.manage)
//            false = Agents edit snippets directly again (back to the default)
//
// The write is a thin wrapper over set_role_capabilities for the Agent role,
// the ONLY path that changes a role: it keeps every guardrail (edit only roles
// below your own, never grant what you do not hold, change log, audit row).
// Nothing here changes a workspace by itself: defaults stay as they were.
// ============================================================

import { NextResponse } from "next/server";

import {
  requireAnyCapability,
  requireCapability,
  toErrorResponse,
} from "@/lib/auth/account";
import {
  canEditRole,
  overridesFromRows,
  roleCanBeGranted,
  roleHasCapability,
} from "@/lib/auth/capabilities";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

export interface ApprovalSettings {
  snippets: { needsApproval: boolean };
  tags: { needsApproval: boolean; locked: boolean };
  /** The caller may change the switches (roles.manage and a role above Agent). */
  canEdit: boolean;
}

export async function GET() {
  try {
    const ctx = await requireAnyCapability(["approvals.review", "roles.manage"]);
    const { data, error } = await ctx.supabase
      .from("role_capabilities")
      .select("capability, granted")
      .eq("account_id", ctx.accountId)
      .eq("role", "agent");
    if (error) {
      console.error("[GET /api/account/approvals/settings] fetch error:", error);
      return NextResponse.json({ error: "Failed to load the settings" }, { status: 500 });
    }
    const overrides = overridesFromRows(data);
    const body: ApprovalSettings = {
      snippets: {
        needsApproval: !roleHasCapability("agent", overrides, "snippets.manage"),
      },
      tags: {
        needsApproval: !roleHasCapability("agent", overrides, "tags.manage"),
        // Since migration 088 an Agent can be given tags.manage (the policies test the
        // capability), so this is only locked if that ever changes again.
        locked: !roleCanBeGranted("agent", "tags.manage"),
      },
      canEdit:
        ctx.capabilities.has("roles.manage") &&
        canEditRole(ctx.role, "agent") &&
        ctx.capabilities.has("snippets.manage"),
    };
    return NextResponse.json(body);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireCapability("roles.manage");
    const limit = checkRateLimit(
      `admin:roleCapabilities:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    if (!canEditRole(ctx.role, "agent")) {
      return NextResponse.json(
        { error: "You can only edit roles below your own" },
        { status: 403 },
      );
    }

    const body = (await request.json().catch(() => null)) as { snippets?: unknown } | null;
    if (!body || typeof body.snippets !== "boolean") {
      return NextResponse.json({ error: "'snippets' must be true or false" }, { status: 400 });
    }

    // true => revoke; false => reset to the default (Agents may edit snippets).
    const changes = { "snippets.manage": body.snippets ? false : null };
    const { error } = await ctx.supabase.rpc("set_role_capabilities", {
      target_account_id: ctx.accountId,
      target_role: "agent",
      changes,
    });
    if (error) {
      if (error.code === "42501") {
        return NextResponse.json({ error: error.message }, { status: 403 });
      }
      if (error.code === "22023") {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      console.error("[PATCH /api/account/approvals/settings] rpc error:", error);
      return NextResponse.json({ error: "Failed to update the setting" }, { status: 500 });
    }
    return NextResponse.json({ ok: true, snippets: { needsApproval: body.snippets } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
