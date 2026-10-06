// ============================================================
// Registration page: the signed form token and the keyed hashes.
//
//  - The page is drawn with a token: "<form id>.<issued at, seconds>.<nonce>.<signature>". The signature is an
//    HMAC-SHA256 under a key derived from the workspace-wide encryption key ring (the way the signer's session
//    cookie is, lib/sign/tokens.ts), so no new secret has to be set. A submission must carry a token that is
//    genuine, made for this very form, not older than two hours, and at least three seconds old: a person needs
//    that long to fill a form, a script that posts at once does not wait. It is a speed bump, not a lock: the
//    limits and the optional Turnstile check are what stop a patient script.
//  - The address a person submitted from, and the email they entered, are never stored as they are: they are
//    kept as HMAC-SHA256 hex under a second derived key, enough to count and to spot a repeat, not to read back.
//
// Pure apart from reading the key ring. Every function returns null / a refusal when there is no key.
// ============================================================

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { primaryKeyMaterial } from "@/lib/crypto/keyring";

/** Not sooner than this after the page was drawn. */
export const MIN_FILL_MS = 3000;
/** Not later than this after the page was drawn. */
export const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

function derive(label: string): Buffer | null {
  const material = primaryKeyMaterial();
  return material ? createHmac("sha256", material).update(label).digest() : null;
}

const tokenKey = () => derive("halo-doc-sign-register-token-v1");
const hashKey = () => derive("halo-doc-sign-register-hash-v1");

/** Is there a key to sign and hash with? Without one the page cannot take submissions. */
export const registrationConfigured = (): boolean => tokenKey() !== null;

/** A token for `formId`, issued now, or null when the server has no key. */
export function issueFormToken(formId: string, now: Date = new Date()): string | null {
  const key = tokenKey();
  if (!key) return null;
  const body = `${formId}.${Math.floor(now.getTime() / 1000)}.${randomBytes(8).toString("hex")}`;
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

export type TokenRead = { ok: true; ageMs: number } | { ok: false; reason: "token_invalid" | "token_expired" };

/** Whether `value` is a genuine, unexpired token for exactly this form, and how old it is. */
export function readFormToken(value: unknown, formId: string, now: Date = new Date()): TokenRead {
  const key = tokenKey();
  if (!key || typeof value !== "string" || value.length > 300) return { ok: false, reason: "token_invalid" };
  const parts = value.split(".");
  if (parts.length !== 4) return { ok: false, reason: "token_invalid" };
  const [id, issuedRaw, nonce, sig] = parts;
  if (id !== formId || !/^\d{1,12}$/.test(issuedRaw) || !/^[0-9a-f]{16}$/.test(nonce)) return { ok: false, reason: "token_invalid" };
  const want = createHmac("sha256", key).update(`${id}.${issuedRaw}.${nonce}`).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: "token_invalid" };
  const ageMs = now.getTime() - Number(issuedRaw) * 1000;
  // issued in the future (a clock that moved): not a token this server made a moment ago
  if (ageMs < -60_000) return { ok: false, reason: "token_invalid" };
  if (ageMs > TOKEN_TTL_MS) return { ok: false, reason: "token_expired" };
  return { ok: true, ageMs: Math.max(0, ageMs) };
}

export const isTooFast = (ageMs: number): boolean => ageMs < MIN_FILL_MS;

export type TokenCheck = { ok: true } | { ok: false; reason: "token_invalid" | "token_expired" | "token_too_fast" };

/** The whole check in one call (the page's submit route reads the token first and the speed after the details are valid). */
export function checkFormToken(value: unknown, formId: string, now: Date = new Date()): TokenCheck {
  const read = readFormToken(value, formId, now);
  if (!read.ok) return read;
  return isTooFast(read.ageMs) ? { ok: false, reason: "token_too_fast" } : { ok: true };
}

function keyed(kind: "email" | "ip", value: string): string | null {
  const key = hashKey();
  return key ? createHmac("sha256", key).update(`${kind}:${value}`).digest("hex") : null;
}

/** The email as it is kept for spotting a repeat: lower case, keyed hash. */
export const hashEmail = (email: string): string | null => keyed("email", email.trim().toLowerCase());

/** The caller's address as it is kept: keyed hash. Null for an unknown address. */
export const hashIp = (ip: string | null | undefined): string | null => (ip && ip !== "unknown" ? keyed("ip", ip) : null);
