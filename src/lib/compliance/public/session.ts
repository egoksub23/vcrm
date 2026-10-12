// ============================================================
// Compliance requests, the public forms: the emailed code and the short session that follows it. SERVER ONLY (the key ring is Node).
//
//  - A code is six digits, valid for 15 minutes, five tries, and a person can ask for three codes an hour per address. Stored (compliance_email_codes)
//    only as a keyed hash that also names the form and the (hashed) address, so a code means nothing for another form or another address, and the
//    table holds neither the digits nor the address.
//  - A verified address is carried by a SESSION: "<form id>.<keyed hash of the address>.<issued>.<expires>.<signature>", 60 minutes, in an HttpOnly cookie.
//    It holds a hash of the address, not the address. The submission must carry the same address; the server hashes it and compares.
//  - The keys are derived from the workspace-wide key ring (no new secret to set). Without a key nothing here works and the form says it is not available.
//
// The page's own signed form token (replay and cross-form protection) is Secure Sign's registration token (lib/sign/registration/token.ts), bound to the
// compliance form's id.
// ============================================================

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

import { primaryKeyMaterial } from "@/lib/crypto/keyring";

export const CODE_TTL_MS = 15 * 60_000;
export const CODE_MAX_ATTEMPTS = 5;
export const CODE_SENDS_PER_HOUR = 3;
export const SESSION_TTL_MS = 60 * 60_000;
/** A submission must come this long after the code was entered: a person needs that long to fill a form, a script that posts at once does not wait. */
export const MIN_FILL_AFTER_VERIFY_MS = 8_000;

function derive(label: string): Buffer | null {
  const material = primaryKeyMaterial();
  return material ? createHmac("sha256", material).update(label).digest() : null;
}
const codeKey = () => derive("halo-compliance-code-v1");
const hashKey = () => derive("halo-compliance-hash-v1");
const sessionKey = () => derive("halo-compliance-session-v1");

/** Is there a key to hash and sign with? Without one the public forms are not available. */
export const publicFormsConfigured = (): boolean => sessionKey() !== null;

/** Six digits, uniformly random. */
export const generateCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, "0");

function keyed(kind: string, value: string): string | null {
  const key = hashKey();
  return key ? createHmac("sha256", key).update(`${kind}:${value}`).digest("hex") : null;
}

/** The address as it is kept (to count sends and to bind a session): lower case, keyed hash. Null without a key. */
export const hashEmail = (email: string): string | null => keyed("email", email.trim().toLowerCase());

/** The caller's address as it is kept: keyed hash. Null for an unknown address. */
export const hashIp = (ip: string | null | undefined): string | null => (ip && ip !== "unknown" ? keyed("ip", ip) : null);

/** The hash stored for a code: it names the form and the address, so it means nothing anywhere else. */
export function hashCode(code: string, formId: string, emailHash: string): string | null {
  const key = codeKey();
  return key ? createHmac("sha256", key).update(`${formId}:${emailHash}:${code}`).digest("hex") : null;
}

export function codeMatches(storedHash: string | null | undefined, code: string, formId: string, emailHash: string): boolean {
  if (!storedHash || !/^\d{6}$/.test(code)) return false;
  const want = hashCode(code, formId, emailHash);
  if (!want) return false;
  const a = Buffer.from(storedHash, "hex");
  const b = Buffer.from(want, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export interface StoredCode {
  code_hash: string;
  expires_at: string;
  attempts: number;
  consumed_at: string | null;
}

export type CodeCheck = { ok: true } | { ok: false; reason: "no_code" | "expired" | "too_many_attempts" | "wrong"; attemptsLeft: number };

/**
 * Decide a code entry against what is stored. Pure: the caller records the attempt (`attempts + 1`) BEFORE it calls this, so a crash cannot grant a
 * free guess. `stored.attempts` is the count including this try.
 */
export function checkCode(stored: StoredCode | null, entered: string, formId: string, emailHash: string, now: Date = new Date()): CodeCheck {
  if (!stored || stored.consumed_at) return { ok: false, reason: "no_code", attemptsLeft: 0 };
  if (new Date(stored.expires_at).getTime() <= now.getTime()) return { ok: false, reason: "expired", attemptsLeft: 0 };
  if (stored.attempts > CODE_MAX_ATTEMPTS) return { ok: false, reason: "too_many_attempts", attemptsLeft: 0 };
  if (codeMatches(stored.code_hash, entered, formId, emailHash)) return { ok: true };
  const left = Math.max(0, CODE_MAX_ATTEMPTS - stored.attempts);
  return { ok: false, reason: left === 0 ? "too_many_attempts" : "wrong", attemptsLeft: left };
}

// ---- the session ----------------------------------------------------------------------------------------------------

/** One cookie per form address (the slug is a-z, 0-9 and hyphens: a valid cookie name as it is). */
export const sessionCookieName = (slug: string): string => `cmp-s-${slug}`;

/** A session for a verified address on this form, or null when the server has no key. */
export function createSession(formId: string, emailHash: string, now: Date = new Date()): { value: string; maxAgeSeconds: number } | null {
  const key = sessionKey();
  if (!key) return null;
  const iat = Math.floor(now.getTime() / 1000);
  const exp = Math.floor((now.getTime() + SESSION_TTL_MS) / 1000);
  const body = `${formId}.${emailHash.slice(0, 40)}.${iat}.${exp}`;
  return { value: `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`, maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000) };
}

export type SessionRead = { ok: true; emailHash: string; issuedAtMs: number } | { ok: false };

/** Is `value` a current session for exactly this form? Gives back the hash of the address it carries and when the code was entered. */
export function readSession(value: string | null | undefined, formId: string, now: Date = new Date()): SessionRead {
  const key = sessionKey();
  if (!key || !value || value.length > 400) return { ok: false };
  const parts = value.split(".");
  if (parts.length !== 5) return { ok: false };
  const [id, hash, iatRaw, expRaw, sig] = parts;
  if (id !== formId || !/^[0-9a-f]{40}$/.test(hash) || !/^\d{1,12}$/.test(iatRaw) || !/^\d{1,12}$/.test(expRaw)) return { ok: false };
  if (Number(expRaw) * 1000 <= now.getTime()) return { ok: false };
  const want = createHmac("sha256", key).update(`${id}.${hash}.${iatRaw}.${expRaw}`).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false };
  return { ok: true, emailHash: hash, issuedAtMs: Number(iatRaw) * 1000 };
}

/** Does the session carry exactly this address? */
export function sessionHolds(session: SessionRead, email: string): boolean {
  if (!session.ok) return false;
  const h = hashEmail(email);
  return !!h && h.slice(0, 40) === session.emailHash;
}

/** The Set-Cookie value: HttpOnly, SameSite=Lax, an hour. */
export function sessionCookie(name: string, value: string, maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}
