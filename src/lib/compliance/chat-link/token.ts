// ============================================================
// Compliance requests, the personal closure form link: the token. SERVER ONLY (the key ring is Node).
//
//   token = <link id without dashes (32 hex)>.<32 random bytes, base64url (43 characters)>
//
// The link id half is not a secret: it only says which row to read. The secret half is 256 bits from the system's random source, shown ONCE (in the link the
// customer is sent, and to the agent who made it when the chat could not take it) and never stored. What is stored is `token_hash`: an HMAC-SHA-256 of the
// whole token under a key derived from the workspace-wide key ring (no new secret to set), so a copy of the table cannot be turned into working links and
// a guessed token cannot be tried against a hash it knows. The public routes find the row by the id half and compare the hash in constant time.
// ============================================================

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { primaryKeyMaterial } from "@/lib/crypto/keyring";

const SECRET_BYTES = 32;
const TOKEN_RE = /^([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/;

function key(): Buffer | null {
  const material = primaryKeyMaterial();
  return material ? createHmac("sha256", material).update("halo-compliance-form-link-v1").digest() : null;
}

/** Is there a key to hash tokens with? Without one no link can be made or opened. */
export const linkTokensConfigured = (): boolean => key() !== null;

const dashed = (hex: string): string => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
const undashed = (id: string): string => id.replace(/-/g, "").toLowerCase();

/** The keyed hash stored for a token (hex), or null without a key. */
export function hashLinkToken(token: string): string | null {
  const k = key();
  return k ? createHmac("sha256", k).update(token).digest("hex") : null;
}

export interface MintedToken {
  /** The id the row will carry (chosen here because it is inside the token). */
  linkId: string;
  /** Shown once; never stored. */
  token: string;
  tokenHash: string;
}

/** A new token for a link with this id (a uuid). Null without a key. */
export function mintLinkToken(linkId: string): MintedToken | null {
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const token = `${undashed(linkId)}.${secret}`;
  const tokenHash = hashLinkToken(token);
  return tokenHash ? { linkId, token, tokenHash } : null;
}

/** The link id a token names (a uuid), or null when it is not shaped like a token. Does not say whether the token is genuine. */
export function linkIdOf(token: unknown): string | null {
  if (typeof token !== "string" || token.length > 100) return null;
  const m = TOKEN_RE.exec(token);
  return m ? dashed(m[1]) : null;
}

/** Does `token` match the stored hash? Constant time. False for anything malformed or without a key. */
export function tokenMatches(token: unknown, storedHash: string | null | undefined): boolean {
  if (typeof token !== "string" || !TOKEN_RE.test(token) || !storedHash || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  const want = hashLinkToken(token);
  if (!want) return false;
  const a = Buffer.from(storedHash, "hex");
  const b = Buffer.from(want, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** The path of the page (never the address of the site: the caller adds its own). */
export const linkPath = (token: string): string => `/c/link/${token}`;
