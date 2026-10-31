import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Sends a password-reset email. Points the reset link at /auth/confirm
// (token_hash flow) rather than /auth/callback (PKCE flow) so the
// session can be established server-side without a code verifier.
export async function POST(request: Request) {
  try {
    const { email, siteUrl } = await request.json() as { email: string; siteUrl?: string };
    if (!email) {
      return NextResponse.json({ error: "Email required" }, { status: 400 });
    }

    const base =
      process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "") ??
      siteUrl?.replace(/\/+$/, "") ??
      "http://localhost:3000";

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${base}/auth/confirm?type=recovery&next=/reset-password`,
    });

    // Always return 200 to avoid leaking whether an email exists.
    if (error) {
      console.error("[POST /api/auth/forgot-password] resetPasswordForEmail:", error.message);
    }
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
