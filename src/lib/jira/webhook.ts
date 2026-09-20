// ============================================================
// Inbound Jira webhooks: verification, parsing, de-duplication keys.
//
// WHAT IS NOT CONFIRMED (docs/jira-setup.md lists it too): Atlassian
// documents the authentication of dynamic webhooks for OAuth 2.0 apps only
// as "a bearer token in the Authorization header, signed with the app's
// client secret"; the algorithm and claims are not spelled out. So:
//
//   - The random per-connection token in the URL path is REQUIRED and is the
//     primary secret (constant-time compare).
//   - If an Authorization: Bearer header is present it must verify as an
//     HS256 JWT signed with JIRA_CLIENT_SECRET (and not be expired); a header
//     that fails verification rejects the request. If it is absent the
//     request is accepted as `token_only`. `JIRA_WEBHOOK_VERIFY=path-only`
//     turns the bearer check off, in case real deliveries use a scheme this
//     code does not know.
//   - Whatever happens, the payload is never trusted: it only names an issue
//     to re-read from Jira (see sync.ts). A forged webhook can at most cause
//     one extra read of an issue that is already linked.
// ============================================================

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function extractBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

export interface JwtCheck {
  ok: boolean;
  reason?: "malformed" | "alg" | "signature" | "expired";
}

/** HS256 verification: algorithm pinned, signature constant-time, expiry checked with 60 s leeway. */
export function verifyHs256Jwt(token: string, secret: string, now: number = Date.now()): JwtCheck {
  if (!secret) return { ok: false, reason: "signature" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, p, s] = parts;
  let header: { alg?: string };
  let claims: { exp?: number; nbf?: number };
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  // Never accept "none" or an algorithm the secret was not meant for.
  if (header.alg !== "HS256") return { ok: false, reason: "alg" };
  const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  if (!safeEqual(expected, s)) return { ok: false, reason: "signature" };
  if (typeof claims.exp === "number" && claims.exp * 1000 < now - 60_000) return { ok: false, reason: "expired" };
  if (typeof claims.nbf === "number" && claims.nbf * 1000 > now + 60_000) return { ok: false, reason: "expired" };
  return { ok: true };
}

export type WebhookAuth =
  | { ok: true; level: "jwt" | "token_only" }
  | { ok: false; reason: "bad_token" | "bad_bearer" | "unsigned" };

export function authorizeWebhook(args: {
  pathToken: string;
  expectedToken: string | null;
  authorization: string | null;
  clientSecret: string | null;
  verifyMode?: string | null;
  /**
   * "Require signed deliveries" (the connection's setting): a delivery must
   * carry a bearer token that verifies with the app secret, or it is refused.
   * Off by default until the owner has seen that Atlassian really signs them.
   */
  requireSigned?: boolean;
  now?: number;
}): WebhookAuth {
  // Path token first, always, and without leaking which check failed.
  if (!args.expectedToken || !safeEqual(args.pathToken, args.expectedToken)) return { ok: false, reason: "bad_token" };

  const bearer = extractBearer(args.authorization);
  // Strict mode never falls back to the address alone (also not with JIRA_WEBHOOK_VERIFY=path-only).
  if (args.requireSigned && (!bearer || args.verifyMode === "path-only" || !args.clientSecret)) return { ok: false, reason: "unsigned" };
  if (!bearer) return { ok: true, level: "token_only" };
  if (args.verifyMode === "path-only") return { ok: true, level: "token_only" };
  if (!args.clientSecret) return { ok: true, level: "token_only" };
  return verifyHs256Jwt(bearer, args.clientSecret, args.now).ok
    ? { ok: true, level: "jwt" }
    : { ok: false, reason: "bad_bearer" };
}

// ------------------------------------------------------------
// Payload
// ------------------------------------------------------------

export interface ParsedWebhook {
  event: string;
  issueId: string | null;
  issueKey: string | null;
  commentId: string | null;
  /** Epoch ms from the payload, if present. */
  timestamp: number | null;
  /** Names of the fields the changelog says changed. */
  changedFields: string[];
  /** `issue.self`, used only to cross-check the site. */
  self: string | null;
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v) return v.slice(0, 200);
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Read the parts of a webhook body we use; never throws, never trusts a shape. */
export function parseWebhookPayload(body: unknown): ParsedWebhook {
  const b = rec(body);
  const issue = rec(b.issue);
  const comment = rec(b.comment);
  const changelog = rec(b.changelog);
  const items = Array.isArray(changelog.items) ? changelog.items : [];
  const changed = items
    .map((i) => str(rec(i).field) ?? str(rec(i).fieldId))
    .filter((x): x is string => !!x)
    .slice(0, 50);
  // Comment events name the issue under `issue`, or (older shapes) only in the comment's own self link.
  return {
    event: str(b.webhookEvent) ?? "unknown",
    issueId: str(issue.id),
    issueKey: str(issue.key),
    commentId: str(comment.id),
    timestamp: typeof b.timestamp === "number" ? b.timestamp : null,
    changedFields: changed,
    self: str(issue.self) ?? str(comment.self),
  };
}

/** Does the payload's own link point at this connection's site? Unknown = fine (we re-read anyway). */
export function payloadMatchesSite(self: string | null, siteUrl: string, cloudId: string): boolean {
  if (!self) return true;
  try {
    const u = new URL(self);
    const site = new URL(siteUrl);
    if (u.host.toLowerCase() === site.host.toLowerCase()) return true;
    if (u.host.toLowerCase() === "api.atlassian.com" && u.pathname.toLowerCase().includes(cloudId.toLowerCase())) return true;
    return false;
  } catch {
    return false;
  }
}

/** The de-duplication key: Atlassian's delivery identifier, or a hash of the body. */
export function deliveryKey(identifierHeader: string | null, rawBody: string): string {
  const id = identifierHeader?.trim();
  if (id && id.length <= 200) return id;
  return `body:${createHash("sha256").update(rawBody).digest("hex").slice(0, 40)}`;
}

/** The events that make sense to act on. */
export const HANDLED_EVENTS = new Set([
  "jira:issue_updated",
  "jira:issue_deleted",
  "comment_created",
  "comment_updated",
  "comment_deleted",
]);
