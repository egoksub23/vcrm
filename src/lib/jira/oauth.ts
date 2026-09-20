// ============================================================
// Atlassian OAuth 2.0 (3LO): the authorize URL, the signed one-time state,
// the code exchange, the refresh, and the site list.
//
// Every function takes an injectable `fetch` so it is unit-tested against
// mocked Atlassian responses. Nothing here reads the database; the pending
// connection (`oauth_pending_connections`, channel 'jira') lives in
// ./pending.ts.
// ============================================================

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { JiraAuthError, JiraConfigError, JiraNetworkError, JiraServerError } from "./errors";
import { JIRA_API_BASE, JIRA_AUTH_URL, JIRA_SCOPES, JIRA_TOKEN_URL } from "./types";

type FetchFn = typeof fetch;

export interface JiraOAuthConfig {
  clientId: string;
  clientSecret: string;
}

export function readOAuthConfig(env: Record<string, string | undefined> = process.env): JiraOAuthConfig {
  const clientId = env.JIRA_CLIENT_ID?.trim();
  const clientSecret = env.JIRA_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new JiraConfigError("JIRA_CLIENT_ID and JIRA_CLIENT_SECRET are not configured");
  }
  return { clientId, clientSecret };
}

/** Is the Jira integration switched on for this deployment? */
export function isJiraConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return !!(env.JIRA_CLIENT_ID?.trim() && env.JIRA_CLIENT_SECRET?.trim());
}

/**
 * The callback URL registered in the Atlassian console. It has to match
 * exactly, so `JIRA_OAUTH_REDIRECT` (optional) wins; otherwise it is built
 * from the request's origin.
 */
export function redirectUri(baseUrl: string, env: Record<string, string | undefined> = process.env): string {
  const explicit = env.JIRA_OAUTH_REDIRECT?.trim();
  if (explicit) return explicit;
  return `${baseUrl.replace(/\/+$/, "")}/api/integrations/jira/callback`;
}

// ------------------------------------------------------------
// Signed one-time state
// ------------------------------------------------------------

export const STATE_TTL_MS = 10 * 60_000;

export interface OAuthStatePayload {
  /** Random nonce; also the key of the pending row. */
  n: string;
  /** Workspace and person the sign-in was started for. */
  a: string;
  u: string;
  /** Expiry, epoch ms. */
  e: number;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

function sign(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

/** `<payload>.<signature>`: tamper-evident, bound to a person and workspace, short-lived. */
export function createOAuthState(
  args: { accountId: string; userId: string },
  secret: string,
  now: number = Date.now(),
): { state: string; payload: OAuthStatePayload } {
  if (!secret) throw new JiraConfigError("No secret to sign the OAuth state with");
  const payload: OAuthStatePayload = {
    n: randomBytes(24).toString("base64url"),
    a: args.accountId,
    u: args.userId,
    e: now + STATE_TTL_MS,
  };
  const body = b64(JSON.stringify(payload));
  return { state: `${body}.${sign(body, secret)}`, payload };
}

/**
 * Check a state coming back from Atlassian: right shape, signature matches
 * (constant time), not expired. Returns the payload or null; the caller
 * still has to find the one-time pending row for `payload.n`.
 */
export function verifyOAuthState(
  state: string | null | undefined,
  secret: string,
  now: number = Date.now(),
): OAuthStatePayload | null {
  if (!state || !secret || state.length > 2000) return null;
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = Buffer.from(sign(body, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<OAuthStatePayload>;
    if (typeof p.n !== "string" || typeof p.a !== "string" || typeof p.u !== "string" || typeof p.e !== "number") return null;
    if (p.e < now) return null;
    return p as OAuthStatePayload;
  } catch {
    return null;
  }
}

/** The state is signed with a key derived from the token-encryption key, never the key itself. */
export function stateSecret(env: Record<string, string | undefined> = process.env): string {
  const key = env.ENCRYPTION_KEY;
  if (!key) throw new JiraConfigError("ENCRYPTION_KEY is not configured");
  return createHmac("sha256", key).update("vircle:jira:oauth-state").digest("hex");
}

// ------------------------------------------------------------
// Authorize URL, token calls
// ------------------------------------------------------------

export function buildAuthorizeUrl(args: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: args.clientId,
    scope: JIRA_SCOPES.join(" "),
    redirect_uri: args.redirectUri,
    state: args.state,
    response_type: "code",
    prompt: "consent",
  });
  return `${JIRA_AUTH_URL}?${params.toString()}`;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Read from the token response, never assumed (Atlassian does not promise an hour). */
  expiresAt: Date;
  scope: string | null;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function tokenRequest(
  body: Record<string, string>,
  fetchFn: FetchFn,
  now: number,
): Promise<TokenSet> {
  let res: Response;
  try {
    res = await fetchFn(JIRA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new JiraNetworkError("Could not reach Atlassian to exchange the token");
  }
  const data = (await readJson(res)) as TokenResponse | null;
  if (!res.ok) {
    // invalid_grant (revoked, expired, already used, password changed) and
    // 400/401/403 from the token endpoint all mean: this connection is dead.
    if (res.status >= 500 || res.status === 429) throw new JiraServerError("Atlassian token service is unavailable", res.status);
    throw new JiraAuthError(data?.error === "invalid_grant" ? "invalid_grant" : (data?.error ?? `token endpoint ${res.status}`), res.status);
  }
  if (!data?.access_token || !data.refresh_token) {
    throw new JiraAuthError("Atlassian did not return a refresh token (was offline_access requested?)", res.status);
  }
  const seconds = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 3600;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(now + seconds * 1000),
    scope: data.scope ?? null,
  };
}

export function exchangeCodeForTokens(
  args: { code: string; redirectUri: string; config: JiraOAuthConfig },
  deps: { fetch?: FetchFn; now?: () => number } = {},
): Promise<TokenSet> {
  return tokenRequest(
    {
      grant_type: "authorization_code",
      client_id: args.config.clientId,
      client_secret: args.config.clientSecret,
      code: args.code,
      redirect_uri: args.redirectUri,
    },
    deps.fetch ?? fetch,
    (deps.now ?? Date.now)(),
  );
}

/** Refresh. Atlassian ROTATES the refresh token: the caller must save the new one atomically. */
export function refreshTokens(
  args: { refreshToken: string; config: JiraOAuthConfig },
  deps: { fetch?: FetchFn; now?: () => number } = {},
): Promise<TokenSet> {
  return tokenRequest(
    {
      grant_type: "refresh_token",
      client_id: args.config.clientId,
      client_secret: args.config.clientSecret,
      refresh_token: args.refreshToken,
    },
    deps.fetch ?? fetch,
    (deps.now ?? Date.now)(),
  );
}

// ------------------------------------------------------------
// Sites
// ------------------------------------------------------------

export interface AccessibleSite {
  /** The cloud id: a UUID, validated. */
  id: string;
  url: string;
  name: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isCloudId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** A site address that is only ever shown or linked to (never fetched). */
export function isSiteUrl(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 200) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.username === "" && u.password === "" && /^[a-z0-9.-]+$/i.test(u.hostname);
  } catch {
    return false;
  }
}

export async function fetchAccessibleResources(
  accessToken: string,
  deps: { fetch?: FetchFn } = {},
): Promise<AccessibleSite[]> {
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`${JIRA_API_BASE}/oauth/token/accessible-resources`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
  } catch {
    throw new JiraNetworkError("Could not reach Atlassian to list your sites");
  }
  if (res.status === 401 || res.status === 403) throw new JiraAuthError("Atlassian did not accept the sign-in", res.status);
  if (!res.ok) throw new JiraServerError("Could not list your Jira sites", res.status);
  const data = await readJson(res);
  if (!Array.isArray(data)) return [];
  const out: AccessibleSite[] = [];
  for (const r of data as { id?: unknown; url?: unknown; name?: unknown }[]) {
    if (isCloudId(r?.id) && isSiteUrl(r?.url)) {
      out.push({ id: r.id.toLowerCase(), url: (r.url as string).replace(/\/+$/, ""), name: typeof r.name === "string" && r.name ? r.name.slice(0, 120) : String(r.url) });
    }
  }
  return out;
}
