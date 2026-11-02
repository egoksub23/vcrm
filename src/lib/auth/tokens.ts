// Recovery and confirmation token utilities — Phase 3 Supabase Auth removal.
//
// Replaces GoTrue's token generation (auth.admin.generateLink) and
// verification (supabase.auth.verifyOtp) with direct PostgreSQL operations
// against the existing auth.users columns (recovery_token, confirmation_token,
// etc.) that GoTrue itself used.

import { createHash, randomBytes } from "crypto";
import { SignJWT, jwtVerify } from "jose";
import { getPool } from "@/lib/postgres/client";

const RECOVERY_JWT_SECRET = new TextEncoder().encode(
  process.env.SUPABASE_JWT_SECRET!,
);

/** Generate a 256-bit random token and its SHA-256 hash. The raw form goes
 *  in the URL; the hash is stored in auth.users. */
export function generateToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

/** Store a recovery token for the given email. Returns the raw token (for the
 *  reset URL), or null when no active user with that email exists. Callers
 *  should always return 200 regardless to avoid leaking account existence. */
export async function storeRecoveryToken(email: string): Promise<string | null> {
  const { raw, hash } = generateToken();
  const sql = getPool();
  const rows = await sql`
    UPDATE auth.users
       SET recovery_token   = ${hash},
           recovery_sent_at = NOW(),
           updated_at       = NOW()
     WHERE email      = ${email}
       AND deleted_at IS NULL
     RETURNING id
  ` as unknown as Array<{ id: string }>;
  return rows.length > 0 ? raw : null;
}

/** Verify a raw recovery token. On success, clears the token from auth.users
 *  (one-time use) and returns the user's id. Returns null if the token is
 *  unknown, expired (>1 h), or already consumed. */
export async function verifyAndConsumeRecoveryToken(
  rawToken: string,
): Promise<string | null> {
  const hash = createHash("sha256").update(rawToken).digest("hex");
  const sql = getPool();
  const rows = await sql`
    UPDATE auth.users
       SET recovery_token   = NULL,
           recovery_sent_at = NULL,
           updated_at       = NOW()
     WHERE recovery_token   = ${hash}
       AND recovery_sent_at > NOW() - INTERVAL '1 hour'
       AND deleted_at IS NULL
     RETURNING id
  ` as unknown as Array<{ id: string }>;
  return rows.length > 0 ? rows[0].id : null;
}

/** Store an email-confirmation token for a newly signed-up user (not yet
 *  email_confirmed_at). Returns the raw token to include in the confirm URL. */
export async function storeConfirmationToken(userId: string): Promise<string> {
  const { raw, hash } = generateToken();
  const sql = getPool();
  await sql`
    UPDATE auth.users
       SET confirmation_token   = ${hash},
           confirmation_sent_at = NOW(),
           updated_at           = NOW()
     WHERE id = ${userId}
  `;
  return raw;
}

/** Verify a confirmation token. On success, marks email_confirmed_at and
 *  clears the token, then returns the user's id. Expires after 24 h. */
export async function verifyAndConsumeConfirmationToken(
  rawToken: string,
): Promise<string | null> {
  const hash = createHash("sha256").update(rawToken).digest("hex");
  const sql = getPool();
  const rows = await sql`
    UPDATE auth.users
       SET email_confirmed_at    = NOW(),
           confirmation_token    = NULL,
           confirmation_sent_at  = NULL,
           updated_at            = NOW()
     WHERE confirmation_token    = ${hash}
       AND confirmation_sent_at  > NOW() - INTERVAL '24 hours'
       AND deleted_at IS NULL
     RETURNING id
  ` as unknown as Array<{ id: string }>;
  return rows.length > 0 ? rows[0].id : null;
}

/** Sign a short-lived JWT that represents a "password reset in progress"
 *  session. Set as the sb-access-token cookie by /auth/confirm (recovery
 *  flow); verified by /api/auth/reset-password. */
export async function signRecoveryCookie(userId: string): Promise<string> {
  return new SignJWT({ sub: userId, purpose: "recovery" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("60m")
    .sign(RECOVERY_JWT_SECRET);
}

/** Verify a recovery cookie and return the user ID, or null when
 *  invalid, expired, or not a recovery token. */
export async function verifyRecoveryCookie(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, RECOVERY_JWT_SECRET);
    if (payload.purpose !== "recovery" || typeof payload.sub !== "string") {
      return null;
    }
    return payload.sub;
  } catch {
    return null;
  }
}
