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
import { createAdminPgDb } from "@/lib/postgres/db";
import { getPool } from "@/lib/postgres/client";
import { storeRecoveryToken } from "@/lib/auth/tokens";
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

    const admin = createAdminPgDb();
    const sql = getPool();

    // Check for existing user first to return a clean 409.
    const existingRows = await sql`
      SELECT id FROM auth.users
       WHERE LOWER(email) = LOWER(${ownerEmail})
         AND deleted_at IS NULL
       LIMIT 1
    ` as unknown as Array<{ id: string }>;
    if (existingRows.length > 0) {
      return NextResponse.json(
        { error: "That email already has a login" },
        { status: 409 },
      );
    }

    // INSERT into auth.users directly — the handle_new_user trigger fires
    // and builds the account + owner profile synchronously.
    // Pass objects directly (not JSON.stringify + ::jsonb) so postgres.js sends
    // them with the JSONB type OID, which the enforce_invite_only_signup trigger
    // reads via raw_app_meta_data ->> 'provisioned'.
    const metaObj = { full_name: ownerName ?? companyName };
    const appMetaObj = { provisioned: true };
    const createdRows = await sql`
      INSERT INTO auth.users (
        id, instance_id, aud, role, email,
        email_confirmed_at, raw_user_meta_data, raw_app_meta_data,
        created_at, updated_at, is_anonymous, is_sso_user
      ) VALUES (
        gen_random_uuid(),
        '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', ${ownerEmail},
        NOW(), ${metaObj}, ${appMetaObj},
        NOW(), NOW(), false, false
      )
      RETURNING id
    ` as unknown as Array<{ id: string }>;
    if (createdRows.length === 0) {
      console.error("[POST /api/platform/accounts] INSERT into auth.users returned no row");
      return NextResponse.json(
        { error: "Could not create the owner login" },
        { status: 500 },
      );
    }
    const userId = createdRows[0].id;

    // handle_new_user builds the account + owner profile synchronously.
    const { data: profile } = await admin
      .from("profiles")
      .select("account_id")
      .eq("user_id", userId)
      .maybeSingle();
    const accountId = (profile as { account_id?: string } | null)?.account_id;
    if (!accountId) {
      console.error("[POST /api/platform/accounts] no account was created for", userId);
      // Rollback: delete the auth user directly from auth.users.
      await sql`
        DELETE FROM auth.users WHERE id = ${userId}
      `.catch(() => {});
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

    // One-time "set your password" link — generate a recovery token and store
    // its hash in auth.users, then build the confirm URL with the raw token.
    const rawToken = await storeRecoveryToken(ownerEmail);
    if (!rawToken) {
      console.error("[POST /api/platform/accounts] storeRecoveryToken returned null for", ownerEmail);
      return NextResponse.json(
        {
          accountId,
          emailed: false,
          warning: "Workspace created, but the password link could not be generated. Use 'Forgot password' for that email.",
        },
        { status: 201 },
      );
    }
    const url = `${getBaseUrl(request)}/auth/confirm?token_hash=${encodeURIComponent(rawToken)}&type=recovery&next=${encodeURIComponent("/reset-password")}`;

    const emailed = await sendTenantWelcomeEmail({ to: ownerEmail, companyName, ownerName, url });

    return NextResponse.json(
      { accountId, emailed, ...(emailed ? {} : { setPasswordUrl: url }) },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
