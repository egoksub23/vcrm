// ============================================================
// /api/platform/accounts — the operator console's tenant list and
// "create a customer workspace".
//
//   GET   — every workspace with plan, status, limits, features and
//           headline counts (platform_list_accounts, DEFINER, operator only).
//   POST  — create a workspace for a new customer:
//             { companyName, ownerEmail, ownerName?, plan?, seats? }
//           Creates the owner's login through the admin API (flagged
//           `app_metadata.provisioned`, which the invite-only signup gate
//           of a later migration recognises), lets the existing
//           handle_new_user trigger build the account + owner profile,
//           renames the account to the company, applies plan/seats, then
//           emails a one-time "set your password" link. With no email
//           provider configured the link is returned to the operator
//           instead (they are trusted; the customer cannot be onboarded
//           otherwise).
//
// Operator only (requirePlatformAdmin). Every request is rate limited.
// ============================================================
import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { sendTenantWelcomeEmail } from "@/lib/email/tenant-welcome-email";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { requirePlatformAdmin } from "@/lib/platform/auth";
import { parseCreateTenant } from "@/lib/platform/validate";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

function getBaseUrl(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwardedHost) return `${forwardedProto || "https"}://${forwardedHost}`;
  return new URL(request.url).origin;
}

export async function GET() {
  try {
    const ctx = await requirePlatformAdmin();
    const { data, error } = await ctx.supabase.rpc("platform_list_accounts");
    if (error) {
      console.error("[GET /api/platform/accounts] rpc error:", error);
      return NextResponse.json({ error: "Failed to load workspaces" }, { status: 500 });
    }
    return NextResponse.json(
      { accounts: data ?? [] },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requirePlatformAdmin();

    const limit = checkRateLimit(`platform:create:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const parsed = parseCreateTenant(await request.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const { companyName, ownerEmail, ownerName, plan, seats } = parsed.value;

    const admin = supabaseAdmin();

    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: ownerEmail,
      email_confirm: true,
      user_metadata: { full_name: ownerName ?? companyName },
      app_metadata: { provisioned: true },
    });
    if (createError || !created.user) {
      const already = /already|registered|exists/i.test(createError?.message ?? "");
      if (!already) console.error("[POST /api/platform/accounts] createUser error:", createError);
      return NextResponse.json(
        { error: already ? "That email already has a login" : "Could not create the owner login" },
        { status: already ? 409 : 500 },
      );
    }
    const userId = created.user.id;

    // handle_new_user builds the account + owner profile synchronously.
    const { data: profile } = await admin
      .from("profiles")
      .select("account_id")
      .eq("user_id", userId)
      .maybeSingle();
    const accountId = (profile as { account_id?: string } | null)?.account_id;
    if (!accountId) {
      console.error("[POST /api/platform/accounts] no account was created for", userId);
      await admin.auth.admin.deleteUser(userId).catch(() => {});
      return NextResponse.json({ error: "Could not create the workspace" }, { status: 500 });
    }

    const { error: renameError } = await admin
      .from("accounts")
      .update({ name: companyName })
      .eq("id", accountId);
    if (renameError) console.error("[POST /api/platform/accounts] rename failed:", renameError);

    const platformPatch: Record<string, unknown> = {};
    if (plan) platformPatch.plan = plan;
    if (seats !== null) platformPatch.limits = { seats };
    if (Object.keys(platformPatch).length > 0) {
      const { error: platformError } = await admin
        .from("account_platform")
        .update(platformPatch)
        .eq("account_id", accountId);
      if (platformError) console.error("[POST /api/platform/accounts] plan/limits failed:", platformError);
    }

    // One-time "set your password" link, verified server-side at
    // /auth/confirm (no dependence on a URL fragment or a browser PKCE
    // verifier).
    const { data: link, error: linkError } = await admin.auth.admin.generateLink({
      type: "recovery",
      email: ownerEmail,
    });
    const hashed = link?.properties?.hashed_token;
    if (linkError || !hashed) {
      console.error("[POST /api/platform/accounts] generateLink failed:", linkError);
      return NextResponse.json(
        {
          accountId,
          emailed: false,
          warning: "Workspace created, but the password link could not be generated. Use 'Forgot password' for that email.",
        },
        { status: 201 },
      );
    }
    const url = `${getBaseUrl(request)}/auth/confirm?token_hash=${encodeURIComponent(hashed)}&type=recovery&next=${encodeURIComponent("/reset-password")}`;

    const emailed = await sendTenantWelcomeEmail({ to: ownerEmail, companyName, ownerName, url });

    return NextResponse.json(
      { accountId, emailed, ...(emailed ? {} : { setPasswordUrl: url }) },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
