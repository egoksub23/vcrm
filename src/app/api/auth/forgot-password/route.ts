import { NextResponse } from "next/server";
import { storeRecoveryToken } from "@/lib/auth/tokens";
import { sendPasswordResetEmail } from "@/lib/email/password-reset-email";

export async function POST(request: Request) {
  try {
    const { email, siteUrl } = (await request.json()) as {
      email: string;
      siteUrl?: string;
    };
    if (!email) {
      return NextResponse.json({ error: "Email required" }, { status: 400 });
    }

    const base =
      process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "") ??
      siteUrl?.replace(/\/+$/, "") ??
      "http://localhost:3000";

    // Always return 200 to avoid leaking whether the email exists.
    const rawToken = await storeRecoveryToken(email);
    if (rawToken) {
      const url = `${base}/auth/confirm?token_hash=${encodeURIComponent(rawToken)}&type=recovery&next=${encodeURIComponent("/reset-password")}`;
      const sent = await sendPasswordResetEmail({ to: email, url });
      if (!sent) {
        // Log the link so operators can retrieve it from docker logs on
        // environments where Resend is not configured (e.g. UAT).
        console.warn(
          "[POST /api/auth/forgot-password] Resend not configured — reset link for",
          email,
          "→",
          url,
        );
      }
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
