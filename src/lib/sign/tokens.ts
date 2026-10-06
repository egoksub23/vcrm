// ============================================================
// Link tokens, verification codes and signer sessions.
//
//  - A link token is made by the database (sign_issue_token, migration 158): two random UUIDs, 64 hex
//    characters. Only its SHA-256 is stored. Here it is recognised and hashed.
//  - A verification code is six digits, valid for 10 minutes, five tries, stored as a salted hash.
//  - A session proves, for a few hours and for one signer only, that the code was entered. It is an
//    HMAC-signed value in an HttpOnly cookie, keyed from the workspace-wide encryption key ring.
// ============================================================

import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";

import { primaryKeyMaterial } from "@/lib/crypto/keyring";

export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_MAX_ATTEMPTS = 5;
/** At most this many codes a signer can ask for in an hour. */
export const CODE_SENDS_PER_HOUR = 5;
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const TOKEN_RE = /^[0-9a-f]{64}$/;

/** A string that could be a link token. Anything else is rejected before the database is asked. */
export function isPlausibleToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_RE.test(token);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Six digits, uniformly random. */
export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** The hash stored for a code; salted with the signer so equal codes look different. */
export function hashCode(code: string, signerId: string): string {
  return createHash("sha256").update(`${signerId}:${code}`, "utf8").digest("hex");
}

export function codeMatches(storedHash: string | null | undefined, code: string, signerId: string): boolean {
  if (!storedHash || !/^\d{6}$/.test(code)) return false;
  const a = Buffer.from(storedHash, "hex");
  const b = Buffer.from(hashCode(code, signerId), "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export type CodeCheck =
  | { ok: true }
  | { ok: false; reason: "no_code" | "expired" | "too_many_attempts" | "wrong"; attemptsLeft: number };

/**
 * Decide a code entry against what is stored. Pure: the caller records the attempt (`attempts + 1`)
 * before it calls this, so a crash cannot grant a free guess.
 */
export function checkCode(
  stored: { code_hash: string | null; code_expires_at: string | null; code_attempts: number },
  entered: string,
  signerId: string,
  now: Date = new Date(),
): CodeCheck {
  if (!stored.code_hash) return { ok: false, reason: "no_code", attemptsLeft: 0 };
  if (!stored.code_expires_at || new Date(stored.code_expires_at) <= now) return { ok: false, reason: "expired", attemptsLeft: 0 };
  const left = CODE_MAX_ATTEMPTS - stored.code_attempts;
  if (left < 0) return { ok: false, reason: "too_many_attempts", attemptsLeft: 0 };
  if (codeMatches(stored.code_hash, entered, signerId)) return { ok: true };
  return { ok: false, reason: left <= 0 ? "too_many_attempts" : "wrong", attemptsLeft: Math.max(0, left) };
}

// ---- sessions ---------------------------------------------------------------

function sessionKey(): Buffer | null {
  const material = primaryKeyMaterial();
  if (!material) return null;
  return createHmac("sha256", material).update("halo-doc-sign-session-v1").digest();
}

export const SESSION_COOKIE_PREFIX = "sgs-";

export function sessionCookieName(signerId: string): string {
  return `${SESSION_COOKIE_PREFIX}${signerId}`;
}

/** A signed session for `signerId`, or null when the server has no key to sign with. */
export function createSession(signerId: string, now: Date = new Date()): { value: string; maxAgeSeconds: number } | null {
  const key = sessionKey();
  if (!key) return null;
  const exp = Math.floor((now.getTime() + SESSION_TTL_MS) / 1000);
  const body = `${signerId}.${exp}`;
  const sig = createHmac("sha256", key).update(body).digest("base64url");
  return { value: `${body}.${sig}`, maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000) };
}

/** Is `value` a current session for exactly this signer? */
export function verifySession(value: string | null | undefined, signerId: string, now: Date = new Date()): boolean {
  if (!value) return false;
  const key = sessionKey();
  if (!key) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [id, expRaw, sig] = parts;
  if (id !== signerId || !/^\d{1,12}$/.test(expRaw)) return false;
  if (Number(expRaw) * 1000 <= now.getTime()) return false;
  const want = createHmac("sha256", key).update(`${id}.${expRaw}`).digest();
  const got = Buffer.from(sig, "base64url");
  return got.length === want.length && timingSafeEqual(got, want);
}
