// /auth/confirm
//
//   GET ?token_hash=...&type=recovery|signup&next=/path
//
// Replaces GoTrue's OTP verification (supabase.auth.verifyOtp) with our own
// token mechanism that stores hashes directly in auth.users:
//
//   • type=recovery  — password reset initiated by /api/auth/forgot-password
//                      or by /api/platform/accounts (tenant onboarding).
//                      Verifies the one-time hash, then sets sb-access-token
//                      to a signed JWT so /reset-password can identify the user.
//
//   • type=signup    — email confirmation for self-signed-up users.
//                      Verifies the confirmation token and marks
//                      email_confirmed_at, then redirects to `next`.
//
// `next` is restricted to a same-origin relative path to prevent open redirects.

import { NextResponse } from "next/server";
import {
  verifyAndConsumeRecoveryToken,
  verifyAndConsumeConfirmationToken,
  signRecoveryCookie,
} from "@/lib/auth/tokens";

const SUPPORTED_TYPES = new Set(["recovery", "signup"]);

function safeNextPath(raw: string | null): string {
  if (raw && /^\/(?!\/)/.test(raw)) return raw;
  return "/dashboard";
}

function getBaseUrl(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const forwardedHost = request.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim();
  const forwardedProto = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  if (forwardedHost) return `${forwardedProto || "https"}://${forwardedHost}`;

  const host = request.headers.get("host")?.trim();
  if (host) {
    const reqProto = new URL(request.url).protocol.replace(":", "");
    return `${reqProto}://${host}`;
  }

  return new URL(request.url).origin;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const next = safeNextPath(searchParams.get("next"));
  const base = getBaseUrl(request);

  if (!tokenHash || !type || !SUPPORTED_TYPES.has(type)) {
    return NextResponse.redirect(`${base}/login?error=link_expired`);
  }

  if (type === "recovery") {
    const userId = await verifyAndConsumeRecoveryToken(tokenHash);
    if (!userId) {
      return NextResponse.redirect(`${base}/login?error=link_expired`);
    }

    const response = NextResponse.redirect(`${base}${next}`);
    const cookie = await signRecoveryCookie(userId);
    const secure = process.env.NODE_ENV === "production";
    response.cookies.set("sb-access-token", cookie, {
      httpOnly: false,
      secure,
      sameSite: "lax",
      maxAge: 60 * 60,
      path: "/",
    });
    return response;
  }

  if (type === "signup") {
    const userId = await verifyAndConsumeConfirmationToken(tokenHash);
    if (!userId) {
      return NextResponse.redirect(`${base}/login?error=link_expired`);
    }
    return NextResponse.redirect(`${base}${next}`);
  }

  return NextResponse.redirect(`${base}/login?error=link_expired`);
}
