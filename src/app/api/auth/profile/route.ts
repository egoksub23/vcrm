import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { createAdminPgDb } from "@/lib/postgres/db";
import { toErrorResponse, UnauthorizedError } from "@/lib/auth/account";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) throw new UnauthorizedError();
    const userId = session.user.id;

    const adminDb = createAdminPgDb();

    const [profileResult, adminResult] = await Promise.all([
      adminDb
        .from("profiles")
        .select("id, full_name, email, avatar_url, role, beta_features, account_id, account_role")
        .eq("user_id", userId)
        .maybeSingle(),
      adminDb.rpc("is_platform_admin"),
    ]);

    if (profileResult.error) {
      return NextResponse.json({ error: profileResult.error.message }, { status: 500 });
    }

    const profile = profileResult.data;
    if (!profile) {
      return NextResponse.json({ profile: null, account: null, platform: null, isPlatformAdmin: false });
    }

    let account = null;
    let platform = null;

    if (profile.account_id) {
      const [accountResult, currenciesResult, brandResult, platformResult] = await Promise.all([
        adminDb
          .from("accounts")
          .select("id, name, default_currency, sla_response_minutes, status_colors")
          .eq("id", profile.account_id)
          .maybeSingle(),
        adminDb
          .from("accounts")
          .select("currencies")
          .eq("id", profile.account_id)
          .maybeSingle(),
        adminDb
          .from("accounts")
          .select("brand_name, brand_logo_url, email_sender_name, email_reply_to, locale, timezone")
          .eq("id", profile.account_id)
          .maybeSingle(),
        adminDb
          .from("account_platform")
          .select("status, plan, limits, features, suspended_reason, deletion_due_at")
          .eq("account_id", profile.account_id)
          .maybeSingle(),
      ]);

      if (!accountResult.error && accountResult.data) {
        account = {
          ...accountResult.data,
          currencies: currenciesResult.error ? null : currenciesResult.data?.currencies,
          brand_name: brandResult.error ? null : brandResult.data?.brand_name ?? null,
          brand_logo_url: brandResult.error ? null : brandResult.data?.brand_logo_url ?? null,
          email_sender_name: brandResult.error ? null : brandResult.data?.email_sender_name ?? null,
          email_reply_to: brandResult.error ? null : brandResult.data?.email_reply_to ?? null,
          locale: brandResult.error ? null : brandResult.data?.locale ?? null,
          timezone: brandResult.error ? "UTC" : brandResult.data?.timezone ?? "UTC",
        };
      }

      if (!platformResult.error) {
        platform = platformResult.data;
      }
    }

    return NextResponse.json({
      profile,
      account,
      platform,
      isPlatformAdmin: !adminResult.error && adminResult.data === true,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
