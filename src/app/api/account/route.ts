// ============================================================
// /api/account
//
//   GET   — current caller's account + role. Any member.
//   PATCH — rename the account and set its branding.  settings.workspace.
//
// Why both verbs share a route file
//   They speak about the same singular resource (the caller's
//   account) and reuse the same `requireCapability` plumbing. Splitting
//   them across files would duplicate the `account_id` lookup
//   without buying anything.
// ============================================================

import { NextResponse } from "next/server";

import {
  requireCapability,
  getCurrentAccount,
  toErrorResponse,
} from "@/lib/auth/account";
import { parseAccountPatch } from "@/lib/account/branding";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    return NextResponse.json({
      account: ctx.account,
      role: ctx.role,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireCapability("settings.workspace");

    // Per-user limit on admin-class mutations. Bounds accidental
    // abuse (script run in a loop) and a compromised admin session
    // spamming renames. Each admin endpoint keys its own bucket so
    // one route doesn't starve another.
    const limit = checkRateLimit(
      `admin:rename:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    // The workspace's own name, plus the per-tenant branding of migration
    // 133 (product name and logo for the app chrome). Each field is
    // optional; at least one is required.
    const parsed = parseAccountPatch(await request.json().catch(() => null));
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    // RLS allows this UPDATE because accounts_update requires
    // `is_account_member(id, 'admin')`, and requireCapability already
    // guaranteed the caller holds `settings.workspace` (admins).
    const { data, error } = await ctx.supabase
      .from("accounts")
      .update(parsed.value)
      .eq("id", ctx.accountId)
      .select("id, name, brand_name, brand_logo_url, email_sender_name, email_reply_to, locale, timezone")
      .single();

    if (error?.code === "22023") {
      // validate_timezone_column (migration 144): a name Postgres does not know.
      return NextResponse.json({ error: "Unknown timezone" }, { status: 400 });
    }
    if (error) {
      console.error("[PATCH /api/account] update error:", error);
      return NextResponse.json(
        { error: "Failed to update account" },
        { status: 500 },
      );
    }

    return NextResponse.json({ account: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
