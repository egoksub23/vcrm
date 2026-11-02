// Recovery and confirmation token utilities — Phase 3 Supabase Auth removal.
//
// Stores tokens in public.verification_tokens (created in migration 204),
// NOT in auth.users GoTrue columns (recovery_token etc.), so this works
// on both production (full GoTrue schema) and fresh self-hosted installs.

import { createHash, randomBytes } from "crypto";
import { SignJWT, jwtVerify } from "jose";
import { getPool } from "@/lib/postgres/client";

const RECOVERY_JWT_SECRET = new TextEncoder().encode(
  process.env.SUPABASE_JWT_SECRET!,
);

/** Generate a 256-bit random token and its SHA-256 hash. The raw form goes
 *  in the URL; the hash is stored in verification_tokens. */
export function generateToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

/** Store a recovery token for the given email. Returns the raw token (for the
 *  reset URL), or null when no active user with that email exists. */
export async function storeRecoveryToken(email: string): Promise<string | null> {
  const sql = getPool();
  // Check the user exists before storing a token (avoids leaking timing info).
  const users = await sql`
    SELECT id FROM auth.users
     WHERE email     = ${email}
       AND deleted_at IS NULL
     LIMIT 1
  ` as unknown as Array<{ id: string }>;
  if (users.length === 0) return null;

  const { raw, hash } = generateToken();
  // Replace any existing recovery token for this email.
  await sql`DELETE FROM public.verification_tokens WHERE identifier = ${"recovery:" + email}`;
  await sql`
    INSERT INTO public.verification_tokens (identifier, token, expires)
    VALUES (${"recovery:" + email}, ${hash}, NOW() + INTERVAL '1 hour')
  `;
  return raw;
}

/** Verify a raw recovery token. On success, deletes it (one-time use) and
 *  returns the user's id. Returns null if unknown, expired, or already used. */
export async function verifyAndConsumeRecoveryToken(
  rawToken: string,
): Promise<string | null> {
  const hash = createHash("sha256").update(rawToken).digest("hex");
  const sql = getPool();
  const rows = await sql`
    DELETE FROM public.verification_tokens
     WHERE token      = ${hash}
       AND identifier LIKE 'recovery:%'
       AND expires    > NOW()
    RETURNING identifier
  ` as unknown as Array<{ identifier: string }>;
  if (rows.length === 0) return null;

  const email = rows[0].identifier.replace(/^recovery:/, "");
  const users = await sql`
    SELECT id FROM auth.users WHERE email = ${email} AND deleted_at IS NULL LIMIT 1
  ` as unknown as Array<{ id: string }>;
  return users.length > 0 ? users[0].id : null;
}

/** Store an email-confirmation token for a newly signed-up user. Returns the
 *  raw token to include in the confirm URL. */
export async function storeConfirmationToken(userId: string): Promise<string> {
  const { raw, hash } = generateToken();
  const sql = getPool();
  await sql`DELETE FROM public.verification_tokens WHERE identifier = ${"confirm:" + userId}`;
  await sql`
    INSERT INTO public.verification_tokens (identifier, token, expires)
    VALUES (${"confirm:" + userId}, ${hash}, NOW() + INTERVAL '24 hours')
  `;
  return raw;
}

/** Verify a confirmation token. On success, marks email_confirmed_at, deletes
 *  the token, and returns the user's id. Expires after 24 h. */
export async function verifyAndConsumeConfirmationToken(
  rawToken: string,
): Promise<string | null> {
  const hash = createHash("sha256").update(rawToken).digest("hex");
  const sql = getPool();
  const rows = await sql`
    DELETE FROM public.verification_tokens
     WHERE token      = ${hash}
       AND identifier LIKE 'confirm:%'
       AND expires    > NOW()
    RETURNING identifier
  ` as unknown as Array<{ identifier: string }>;
  if (rows.length === 0) return null;

  const userId = rows[0].identifier.replace(/^confirm:/, "");
  await sql`
    UPDATE auth.users SET email_confirmed_at = NOW(), updated_at = NOW()
     WHERE id = ${userId}
  `;
  return userId;
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
