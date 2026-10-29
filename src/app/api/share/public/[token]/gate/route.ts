// ============================================================
// POST /api/share/public/[token]/gate
//
// Gate verification for Secure Share links. Three actions:
//   submit_email — "email" gate: capture the viewer's email and issue a session.
//   request_otp  — "otp" gate step 1: generate + email a 6-digit code.
//   verify_otp   — "otp" gate step 2: check the code and issue a session.
//
// Returns Set-Cookie on success. Rate limited per IP.
// ============================================================

import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { realWorkspaceMailDeps, sendWorkspaceEmail } from "@/lib/email/workspace-mail";
import { clientIp } from "@/lib/net/client-ip";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { shareEnabled } from "@/lib/share/feature";
import {
  createSession,
  generateOtp,
  hashOtp,
  hashToken,
  isPlausibleToken,
  otpMatches,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MS,
  sessionCookieName,
} from "@/lib/share/tokens";

const VALID_EMAIL = /^[^@\s]{1,64}@[^@\s]{1,255}$/;

function badRequest(msg: string) {
  return NextResponse.json({ error: msg }, { status: 400 });
}

function notFound() {
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const requestHeaders = await headers();
  const ip = clientIp(requestHeaders);
  const rate = checkRateLimit(`share-gate:${ip}`, { limit: 20, windowMs: 60_000 });
  if (!rate.success) return rateLimitResponse(rate);

  const { token } = await params;
  if (!isPlausibleToken(token)) return notFound();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid request body.");
  }

  if (!body || typeof body !== "object") return badRequest("Invalid request body.");
  const { action, email, code } = body as Record<string, unknown>;

  if (typeof action !== "string") return badRequest("action is required.");

  const admin = supabaseAdmin();

  // Load share + secrets
  const { data: share } = await admin
    .from("share_links")
    .select("id, account_id, title, gate_type, status, expires_at")
    .eq("token_hash", hashToken(token))
    .maybeSingle();

  if (!share || share.status !== "active") return notFound();
  if (share.expires_at && new Date(share.expires_at) <= new Date()) return notFound();
  if (!(await shareEnabled(admin, share.account_id))) return notFound();

  // ============================================================
  // email gate — just capture the viewer's email
  // ============================================================
  if (action === "submit_email") {
    if (share.gate_type !== "email") return badRequest("This link does not use an email gate.");
    if (typeof email !== "string" || !VALID_EMAIL.test(email)) return badRequest("Enter a valid email address.");

    await admin
      .from("share_link_secrets")
      .update({ gate_email: email.toLowerCase(), gate_email_at: new Date().toISOString() })
      .eq("share_id", share.id);

    return issueSession(share.id);
  }

  // ============================================================
  // otp gate step 1 — generate and email an OTP
  // ============================================================
  if (action === "request_otp") {
    if (share.gate_type !== "otp") return badRequest("This link does not use an OTP gate.");
    if (typeof email !== "string" || !VALID_EMAIL.test(email)) return badRequest("Enter a valid email address.");

    const otp = generateOtp();
    const otpHash = hashOtp(otp, share.id);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();

    await admin
      .from("share_link_secrets")
      .update({ otp_hash: otpHash, otp_expires_at: expiresAt, otp_attempts: 0, gate_email: email.toLowerCase() })
      .eq("share_id", share.id);

    // Send the OTP email via workspace channel (M365/Gmail first, Resend fallback) — best effort
    void sendOtpEmail({ to: email, otp, shareTitle: share.title, accountId: share.account_id }).catch(() => {});

    return NextResponse.json({ ok: true });
  }

  // ============================================================
  // otp gate step 2 — verify the code
  // ============================================================
  if (action === "verify_otp") {
    if (share.gate_type !== "otp") return badRequest("This link does not use an OTP gate.");
    if (typeof code !== "string" || !/^\d{6}$/.test(code)) return badRequest("Enter the 6-digit code.");

    const { data: secrets } = await admin
      .from("share_link_secrets")
      .select("otp_hash, otp_expires_at, otp_attempts")
      .eq("share_id", share.id)
      .maybeSingle();

    if (!secrets?.otp_hash) return NextResponse.json({ error: "Request a new code." }, { status: 400 });
    if (secrets.otp_expires_at && new Date(secrets.otp_expires_at) <= new Date()) {
      return NextResponse.json({ error: "The code has expired. Request a new one." }, { status: 400 });
    }
    if ((secrets.otp_attempts ?? 0) >= OTP_MAX_ATTEMPTS) {
      return NextResponse.json({ error: "Too many attempts. Request a new code." }, { status: 400 });
    }

    if (!otpMatches(secrets.otp_hash, code, share.id)) {
      await admin
        .from("share_link_secrets")
        .update({ otp_attempts: (secrets.otp_attempts ?? 0) + 1 })
        .eq("share_id", share.id);
      return NextResponse.json({ error: "Incorrect code. Try again." }, { status: 400 });
    }

    // Clear the OTP so it cannot be replayed
    await admin
      .from("share_link_secrets")
      .update({ otp_hash: null, otp_expires_at: null, otp_attempts: 0 })
      .eq("share_id", share.id);

    return issueSession(share.id);
  }

  return badRequest(`Unknown action: ${action}`);
}

// ---- helpers ----------------------------------------------------------------

function issueSession(shareId: string): NextResponse {
  const session = createSession(shareId);
  if (!session) {
    return NextResponse.json({ error: "Server configuration error." }, { status: 500 });
  }

  const cookieName = sessionCookieName(shareId);
  const secure = process.env.NODE_ENV === "production";
  const cookieVal =
    `${cookieName}=${encodeURIComponent(session.value)}; ` +
    `Max-Age=${session.maxAgeSeconds}; Path=/; HttpOnly; SameSite=Lax` +
    (secure ? "; Secure" : "");

  return NextResponse.json({ ok: true }, { status: 200, headers: { "Set-Cookie": cookieVal } });
}

async function sendOtpEmail({ to, otp, shareTitle, accountId }: { to: string; otp: string; shareTitle: string; accountId: string }) {
  const productName = process.env.NEXT_PUBLIC_APP_NAME?.trim() || "Halo";
  const html = `<p>Your verification code for <strong>${escHtml(shareTitle)}</strong>:</p>
<p style="font-size:32px;font-weight:bold;letter-spacing:6px;font-family:monospace">${otp}</p>
<p>This code expires in 10 minutes. If you did not request this, ignore this email.</p>
<p style="color:#666;font-size:12px">Sent via ${escHtml(productName)}</p>`;
  const text = `Your verification code for "${shareTitle}": ${otp}\n\nExpires in 10 minutes.`;
  await sendWorkspaceEmail(
    accountId,
    () => ({ subject: `Your access code: ${otp}`, html, text, to }),
    realWorkspaceMailDeps,
  );
}

function escHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
