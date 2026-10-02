// ============================================================
// /api/platform/settings — deployment-wide switches an operator controls.
//
//   GET   — { open_signup }
//   PATCH — { open_signup: boolean }: allow or refuse self-service sign-up
//           (migration 134). When off, a new login is only accepted if it
//           was created by the operator console or carries a valid
//           invitation.
//
// Operator only (requirePlatformAdmin); the platform_set_open_signup RPC
// re-checks it in the database.
// ============================================================
import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/platform/auth";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

export async function GET() {
  try {
    const ctx = await requirePlatformAdmin();
    const { data, error } = await ctx.supabase.rpc("signup_is_open");
    if (error) {
      console.error("[GET /api/platform/settings] signup_is_open failed:", error);
      return NextResponse.json({ error: "Failed to load settings" }, { status: 500 });
    }
    return NextResponse.json(
      { open_signup: data === true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requirePlatformAdmin();

    const limit = checkRateLimit(`platform:settings:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as { open_signup?: unknown } | null;
    if (typeof body?.open_signup !== "boolean") {
      return NextResponse.json({ error: "'open_signup' must be true or false" }, { status: 400 });
    }

    const { error } = await ctx.supabase.rpc("platform_set_open_signup", {
      p_open: body.open_signup,
    });
    if (error) {
      if (error.code === "42501") {
        return NextResponse.json({ error: "Platform administrator access required" }, { status: 403 });
      }
      console.error("[PATCH /api/platform/settings] rpc failed:", error);
      return NextResponse.json({ error: "Update failed" }, { status: 500 });
    }
    return NextResponse.json({ open_signup: body.open_signup });
  } catch (err) {
    return toErrorResponse(err);
  }
}
