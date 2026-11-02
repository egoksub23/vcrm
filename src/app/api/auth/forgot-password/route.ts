import { NextResponse } from "next/server";
import { storeRecoveryToken } from "@/lib/auth/tokens";
import { buildPasswordResetEmail } from "@/lib/email/password-reset-email";
import { sendWorkspaceEmail, realWorkspaceMailDeps } from "@/lib/email/workspace-mail";

/** Look up the workspace account ID for a given user email. Returns null if not found. */
async function getAccountIdForEmail(email: string): Promise<string | null> {
  try {
    const { getPool } = await import("@/lib/postgres/client");
    const sql = getPool();
    const rows = await sql`
      SELECT p.account_id
        FROM profiles p
        JOIN auth.users u ON u.id = p.user_id
       WHERE u.email      = ${email}
         AND u.deleted_at IS NULL
       LIMIT 1
    ` as unknown as Array<{ account_id: string }>;
    return rows.length > 0 ? rows[0].account_id : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  try {
    const { email, siteUrl } = (await request.json()) as {
      email: string;
      siteUrl?: string;
    };
    if (!email) {
      return NextResponse.json({ error: "Email required" }, { status: 400 });
    }

    // Derive base URL from the request host so the link always points to the
    // same domain the user is on (important on UAT where NEXT_PUBLIC_SITE_URL
    // may still point to production).
    const base =
      process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "") ??
      siteUrl?.replace(/\/+$/, "") ??
      "http://localhost:3000";

    // Always return 200 to avoid leaking whether the email exists.
    const rawToken = await storeRecoveryToken(email);
    if (rawToken) {
      const url = `${base}/auth/confirm?token_hash=${encodeURIComponent(rawToken)}&type=recovery&next=${encodeURIComponent("/reset-password")}`;
      const { subject, html, text } = buildPasswordResetEmail(url);

      // Try the workspace's connected mailbox (support@vircle.com) first,
      // then fall back to Resend, then log for operator retrieval.
      const accountId = await getAccountIdForEmail(email);
      let sent = false;

      if (accountId) {
        const result = await sendWorkspaceEmail(
          accountId,
          { to: email, subject, html, text },
          realWorkspaceMailDeps,
        );
        sent = result.status === "sent";
        if (!sent) {
          console.warn(
            "[POST /api/auth/forgot-password] workspace mail failed via",
            result.via,
            "—",
            result.detail ?? "no detail",
          );
        }
      }

      if (!sent) {
        // Log the link so operators can retrieve it from docker logs on
        // environments where neither a workspace mailbox nor Resend is set up.
        console.warn(
          "[POST /api/auth/forgot-password] no email sent — reset link for",
          email,
          "→",
          url,
        );
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[POST /api/auth/forgot-password] error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
