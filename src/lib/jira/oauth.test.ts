import { describe, expect, it, vi } from "vitest";

import { JiraAuthError, JiraNetworkError, JiraServerError } from "./errors";
import {
  buildAuthorizeUrl,
  createOAuthState,
  exchangeCodeForTokens,
  fetchAccessibleResources,
  isCloudId,
  isJiraConfigured,
  isSiteUrl,
  readOAuthConfig,
  redirectUri,
  refreshTokens,
  STATE_TTL_MS,
  stateSecret,
  verifyOAuthState,
} from "./oauth";
import { JIRA_SCOPES } from "./types";

const SECRET = "test-state-secret";
const CONFIG = { clientId: "client-1", clientSecret: "shh" };
const NOW = Date.parse("2026-09-20T10:00:00Z");

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

describe("OAuth state", () => {
  it("round-trips, bound to the person and workspace", () => {
    const { state, payload } = createOAuthState({ accountId: "acct", userId: "user" }, SECRET, NOW);
    const back = verifyOAuthState(state, SECRET, NOW + 1000);
    expect(back).toEqual(payload);
    expect(back).toMatchObject({ a: "acct", u: "user" });
  });

  it("is different every time (a one-time nonce)", () => {
    const a = createOAuthState({ accountId: "a", userId: "u" }, SECRET, NOW).state;
    const b = createOAuthState({ accountId: "a", userId: "u" }, SECRET, NOW).state;
    expect(a).not.toBe(b);
  });

  it("rejects a tampered payload, a wrong secret, and a forged signature", () => {
    const { state } = createOAuthState({ accountId: "acct", userId: "user" }, SECRET, NOW);
    const [body, sig] = state.split(".");
    const forgedBody = Buffer.from(JSON.stringify({ n: "x", a: "other-acct", u: "user", e: NOW + 60_000 })).toString("base64url");
    expect(verifyOAuthState(`${forgedBody}.${sig}`, SECRET, NOW)).toBeNull();
    expect(verifyOAuthState(state, "another-secret", NOW)).toBeNull();
    expect(verifyOAuthState(`${body}.AAAA`, SECRET, NOW)).toBeNull();
    expect(verifyOAuthState(`${body}.${sig}x`, SECRET, NOW)).toBeNull();
  });

  it("rejects expired, malformed and empty states", () => {
    const { state } = createOAuthState({ accountId: "acct", userId: "user" }, SECRET, NOW);
    expect(verifyOAuthState(state, SECRET, NOW + STATE_TTL_MS + 1)).toBeNull();
    for (const bad of [null, undefined, "", "nodot", "a.b.c", ".", "x".repeat(5000)]) {
      expect(verifyOAuthState(bad as string, SECRET, NOW)).toBeNull();
    }
    expect(verifyOAuthState(state, "", NOW)).toBeNull();
  });

  it("derives the signing secret from ENCRYPTION_KEY, never using the key itself", () => {
    const s = stateSecret({ ENCRYPTION_KEY: "abc" });
    expect(s).not.toContain("abc");
    expect(s).toHaveLength(64);
    expect(() => stateSecret({})).toThrow();
  });
});

describe("configuration", () => {
  it("needs both Jira env vars", () => {
    expect(isJiraConfigured({})).toBe(false);
    expect(isJiraConfigured({ JIRA_CLIENT_ID: "a" })).toBe(false);
    expect(isJiraConfigured({ JIRA_CLIENT_ID: "a", JIRA_CLIENT_SECRET: "b" })).toBe(true);
    expect(() => readOAuthConfig({})).toThrow(/not configured/);
    expect(readOAuthConfig({ JIRA_CLIENT_ID: " a ", JIRA_CLIENT_SECRET: " b " })).toEqual({ clientId: "a", clientSecret: "b" });
  });

  it("builds the callback address exactly, unless JIRA_OAUTH_REDIRECT overrides it", () => {
    expect(redirectUri("https://crm.example.com/", {})).toBe("https://crm.example.com/api/integrations/jira/callback");
    expect(redirectUri("https://crm.example.com", { JIRA_OAUTH_REDIRECT: "https://other.example/api/integrations/jira/callback" })).toBe(
      "https://other.example/api/integrations/jira/callback",
    );
  });

  it("builds the authorize URL with the five classic scopes, consent and the state", () => {
    const url = new URL(buildAuthorizeUrl({ clientId: "cid", redirectUri: "https://crm.example.com/api/integrations/jira/callback", state: "st" }));
    expect(url.origin + url.pathname).toBe("https://auth.atlassian.com/authorize");
    expect(url.searchParams.get("audience")).toBe("api.atlassian.com");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...JIRA_SCOPES]);
    expect(url.searchParams.get("scope")).not.toMatch(/manage:jira-(project|configuration)/);
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("response_type")).toBe("code");
  });
});

describe("token calls", () => {
  it("exchanges a code and reads the expiry from the response", async () => {
    const f = vi.fn(async () => json(200, { access_token: "A", refresh_token: "R", expires_in: 900, scope: "read:jira-work" }));
    const t = await exchangeCodeForTokens({ code: "c", redirectUri: "https://x/cb", config: CONFIG }, { fetch: f as never, now: () => NOW });
    expect(t.accessToken).toBe("A");
    expect(t.refreshToken).toBe("R");
    expect(t.expiresAt.getTime()).toBe(NOW + 900_000); // not an assumed hour
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://auth.atlassian.com/oauth/token");
    expect(JSON.parse(init.body as string)).toMatchObject({ grant_type: "authorization_code", code: "c", client_id: "client-1", redirect_uri: "https://x/cb" });
  });

  it("refuses a response without a refresh token (offline_access missing)", async () => {
    const f = vi.fn(async () => json(200, { access_token: "A", expires_in: 3600 }));
    await expect(exchangeCodeForTokens({ code: "c", redirectUri: "u", config: CONFIG }, { fetch: f as never })).rejects.toBeInstanceOf(JiraAuthError);
  });

  it("maps invalid_grant to an auth error and 5xx to a server error", async () => {
    const dead = vi.fn(async () => json(403, { error: "invalid_grant", error_description: "gone" }));
    await expect(refreshTokens({ refreshToken: "R", config: CONFIG }, { fetch: dead as never })).rejects.toMatchObject({ name: "JiraAuthError", message: "invalid_grant" });
    const down = vi.fn(async () => json(503, {}));
    await expect(refreshTokens({ refreshToken: "R", config: CONFIG }, { fetch: down as never })).rejects.toBeInstanceOf(JiraServerError);
    const off = vi.fn(async () => {
      throw new TypeError("network");
    });
    await expect(refreshTokens({ refreshToken: "R", config: CONFIG }, { fetch: off as never })).rejects.toBeInstanceOf(JiraNetworkError);
  });

  it("sends the refresh grant with the rotating refresh token", async () => {
    const f = vi.fn(async () => json(200, { access_token: "A2", refresh_token: "R2", expires_in: 3600 }));
    const t = await refreshTokens({ refreshToken: "R1", config: CONFIG }, { fetch: f as never, now: () => NOW });
    expect(t.refreshToken).toBe("R2");
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ grant_type: "refresh_token", refresh_token: "R1" });
  });
});

describe("sites", () => {
  it("keeps only sites with a UUID cloud id and an https address", async () => {
    const f = vi.fn(async () =>
      json(200, [
        { id: "11111111-2222-4333-8444-555555555555", url: "https://acme.atlassian.net/", name: "Acme" },
        { id: "../../etc", url: "https://evil.example", name: "Bad id" },
        { id: "22222222-2222-4333-8444-555555555555", url: "http://plain.example", name: "Not https" },
        { id: "33333333-2222-4333-8444-555555555555", url: "https://user:pw@x.example", name: "Creds" },
        { id: "44444444-2222-4333-8444-555555555555", url: "javascript:alert(1)", name: "js" },
      ]),
    );
    const sites = await fetchAccessibleResources("token", { fetch: f as never });
    expect(sites).toEqual([{ id: "11111111-2222-4333-8444-555555555555", url: "https://acme.atlassian.net", name: "Acme" }]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.atlassian.com/oauth/token/accessible-resources");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token");
  });

  it("maps 401 and 5xx", async () => {
    await expect(fetchAccessibleResources("t", { fetch: (async () => json(401, {})) as never })).rejects.toBeInstanceOf(JiraAuthError);
    await expect(fetchAccessibleResources("t", { fetch: (async () => json(500, {})) as never })).rejects.toBeInstanceOf(JiraServerError);
    expect(await fetchAccessibleResources("t", { fetch: (async () => json(200, { not: "an array" })) as never })).toEqual([]);
  });

  it("validates cloud ids and site URLs", () => {
    expect(isCloudId("11111111-2222-4333-8444-555555555555")).toBe(true);
    for (const bad of ["", "x", "11111111-2222-4333-8444-55555555555", "11111111-2222-4333-8444-555555555555/../x", 5, null]) expect(isCloudId(bad)).toBe(false);
    expect(isSiteUrl("https://acme.atlassian.net")).toBe(true);
    expect(isSiteUrl("http://acme.atlassian.net")).toBe(false);
    expect(isSiteUrl("https://acme.atlassian.net@evil.example")).toBe(false);
  });
});
