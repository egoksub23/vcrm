// Intake keys and report-link tokens for the coach portal. Pure and testable: no database, no clock beyond what is passed in.
//
//   Key:    ik_live_<43 chars> or ik_test_<43 chars>. Shown once. Only the SHA-256 hash is stored, so a database read cannot reveal a key.
//   Token:  <base64url(claims)>.<mac>, claims = { s: sessionId, o: [allowed frame origins] }. Signed with HMAC, so the proxy can read the origins to
//           build the frame-ancestors header without a database call, and a repeated launch (same idempotency key) returns exactly the same link.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type KeyMode = "live" | "test";
export const KEY_SCOPES = ["launch", "clearances.read"] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];

export function generateKey(mode: KeyMode): { key: string; prefix: string; hash: string } {
  const key = `ik_${mode}_${randomBytes(32).toString("base64url")}`;
  return { key, prefix: key.slice(0, 12), hash: hashKey(key) };
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** The key out of an `Authorization: Bearer ...` header (or a bare key), or null when it is not shaped like one of ours. */
export function keyFromHeader(header: string | null | undefined): string | null {
  if (!header) return null;
  const raw = header.replace(/^Bearer\s+/i, "").trim();
  return /^ik_(live|test)_[A-Za-z0-9_-]{43}$/.test(raw) ? raw : null;
}

export function modeOfKey(key: string): KeyMode {
  return key.startsWith("ik_test_") ? "test" : "live";
}

// ---- report-link tokens -----------------------------------------------------------------------------------------

export function intakeSecret(): string {
  return process.env.INCIDENT_INTAKE_SECRET || process.env.INCIDENT_ACK_SECRET || process.env.AUTOMATION_CRON_SECRET || process.env.AUTH_SECRET || "";
}

export interface TokenClaims {
  sessionId: string;
  /** Origins allowed to put the report page in a frame. */
  origins: string[];
}

const mac = (payload: string, secret: string) => createHmac("sha256", secret).update(`incident-report:${payload}`).digest("base64url").slice(0, 32);

export function signSessionToken(claims: TokenClaims, secret = intakeSecret()): string {
  const payload = Buffer.from(JSON.stringify({ s: claims.sessionId, o: claims.origins }), "utf8").toString("base64url");
  return `${payload}.${mac(payload, secret)}`;
}

/** The claims in a token we signed, or null for anything else (wrong secret, edited, malformed, or no secret configured). */
export function readSessionToken(token: string, secret = intakeSecret()): TokenClaims | null {
  if (!secret || token.length > 2000) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(mac(payload, secret));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { s?: unknown; o?: unknown };
    if (typeof parsed.s !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed.s)) return null;
    const origins = Array.isArray(parsed.o) ? parsed.o.filter((o): o is string => typeof o === "string" && isOrigin(o)) : [];
    return { sessionId: parsed.s, origins };
  } catch {
    return null;
  }
}

// ---- origins ----------------------------------------------------------------------------------------------------

/** https://host or https://host:port, nothing else (no path, no query). http is accepted only for localhost (development). */
export function isOrigin(value: string): boolean {
  try {
    const u = new URL(value);
    if (u.origin !== value) return false;
    return u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"));
  } catch {
    return false;
  }
}

/** Tidy the list an admin typed: trims, drops a trailing slash, drops repeats. Returns the problem when one entry is not an origin. */
export function parseOrigins(values: readonly string[]): { ok: true; origins: string[] } | { ok: false; error: string } {
  const out: string[] = [];
  for (const raw of values) {
    const v = raw.trim().replace(/\/+$/, "");
    if (!v) continue;
    if (!isOrigin(v)) return { ok: false, error: `"${raw.trim()}" is not a web address like https://coach.example.edu.my (no path).` };
    if (!out.includes(v)) out.push(v);
  }
  if (out.length > 10) return { ok: false, error: "Ten allowed addresses at most." };
  return { ok: true, origins: out };
}

/** The `Content-Security-Policy` value that lets only the registered origins frame the report page. No origins: nobody may frame it. */
export function frameAncestors(origins: readonly string[]): string {
  return origins.length > 0 ? `frame-ancestors ${origins.join(" ")}` : "frame-ancestors 'none'";
}

/** Is `url` on one of the allowed origins (for the return address after sending)? */
export function urlOnAllowedOrigin(url: string, origins: readonly string[]): boolean {
  try {
    return origins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}
