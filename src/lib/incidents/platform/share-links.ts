// Stateless signed share links for incidents (Phase 3.3).
// A share link encodes the incident id and an expiry timestamp in a signed token; no DB row is needed.
// Anyone with the link can read a limited, public-safe summary (no names, no attachments, no medical detail).
//
// Token format: <base64url(incidentId)>.<expireEpoch>.<hmac-sha256("share:<incidentId>:<expireEpoch>", secret).slice(0,32)>
// The expiry epoch is seconds since Unix epoch; default TTL is 7 days.

import { createHmac, timingSafeEqual } from "node:crypto";

const SHARE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function shareSecret(): string {
  return process.env.INCIDENT_ACK_SECRET || process.env.AUTOMATION_CRON_SECRET || process.env.AUTH_SECRET || "";
}

function toB64(s: string): string {
  return Buffer.from(s).toString("base64url");
}
function fromB64(s: string): string | null {
  try {
    return Buffer.from(s, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

/** Create a signed share token for one incident. Returns null when no secret is configured. */
export function createShareToken(incidentId: string, nowSec = Math.floor(Date.now() / 1000), secret = shareSecret()): string | null {
  if (!secret) return null;
  const expires = nowSec + SHARE_TTL_SECONDS;
  const mac = createHmac("sha256", secret).update(`share:${incidentId}:${expires}`).digest("hex").slice(0, 32);
  return `${toB64(incidentId)}.${expires}.${mac}`;
}

export interface VerifiedShareToken {
  incidentId: string;
  expiresAt: Date;
}

/** Verify a share token. Returns null for a bad, expired or unsigned token. */
export function verifyShareToken(token: string, nowSec = Math.floor(Date.now() / 1000), secret = shareSecret()): VerifiedShareToken | null {
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [b64Id, epochStr, mac] = parts;
  const incidentId = fromB64(b64Id ?? "");
  if (!incidentId || !/^[0-9a-f-]{36}$/i.test(incidentId)) return null;
  const expires = Number(epochStr);
  if (!Number.isInteger(expires) || expires <= nowSec) return null;
  const expected = Buffer.from(createHmac("sha256", secret).update(`share:${incidentId}:${expires}`).digest("hex").slice(0, 32));
  const given = Buffer.from(mac ?? "");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { incidentId, expiresAt: new Date(expires * 1000) };
}
