// ============================================================
// Share tokens and gate sessions.
//
//  - A share token is 64 hex characters (32 random bytes from the database).
//    Only its SHA-256 is stored. Here it is recognised and hashed.
//  - A gate session proves, for 24 hours, that the viewer passed the gate
//    (email capture or OTP). HMAC-signed HttpOnly cookie, one per share.
//  - OTP helpers for the Phase 2 email-OTP gate.
// ============================================================

import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";

import { primaryKeyMaterial } from "@/lib/crypto/keyring";

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;

const TOKEN_RE = /^[0-9a-f]{64}$/;

export function isPlausibleToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_RE.test(token);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashOtp(code: string, shareId: string): string {
  return createHash("sha256").update(`${shareId}:${code}`, "utf8").digest("hex");
}

export function otpMatches(storedHash: string | null | undefined, code: string, shareId: string): boolean {
  if (!storedHash || !/^\d{6}$/.test(code)) return false;
  const a = Buffer.from(storedHash, "hex");
  const b = Buffer.from(hashOtp(code, shareId), "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

// ---- gate sessions ---------------------------------------------------------------

function sessionKey(): Buffer | null {
  const material = primaryKeyMaterial();
  if (!material) return null;
  return createHmac("sha256", material).update("halo-secure-share-session-v1").digest();
}

export const SESSION_COOKIE_PREFIX = "shs-";

export function sessionCookieName(shareId: string): string {
  return `${SESSION_COOKIE_PREFIX}${shareId}`;
}

export function createSession(shareId: string, now: Date = new Date()): { value: string; maxAgeSeconds: number } | null {
  const key = sessionKey();
  if (!key) return null;
  const exp = Math.floor((now.getTime() + SESSION_TTL_MS) / 1000);
  const body = `${shareId}.${exp}`;
  const sig = createHmac("sha256", key).update(body).digest("base64url");
  return { value: `${body}.${sig}`, maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000) };
}

export function verifySession(value: string | null | undefined, shareId: string, now: Date = new Date()): boolean {
  if (!value) return false;
  const key = sessionKey();
  if (!key) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [id, expRaw, sig] = parts;
  if (id !== shareId || !/^\d{1,12}$/.test(expRaw)) return false;
  if (Number(expRaw) * 1000 <= now.getTime()) return false;
  const want = createHmac("sha256", key).update(`${id}.${expRaw}`).digest();
  const got = Buffer.from(sig, "base64url");
  return got.length === want.length && timingSafeEqual(got, want);
}
