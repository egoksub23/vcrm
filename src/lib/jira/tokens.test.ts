import { describe, expect, it, vi } from "vitest";

import { JiraAuthError, JiraServerError } from "./errors";
import type { TokenSet } from "./oauth";
import { TokenManager, type StoredTokens, type TokenStore } from "./tokens";

const CONFIG = { clientId: "c", clientSecret: "s" };
const T0 = Date.parse("2026-09-20T10:00:00Z");

/**
 * An in-memory store with the SAME semantics as the SQL functions: a lease
 * with an expiry, and a compare-and-swap save that only the lease holder,
 * holding the refresh token it started from, can win.
 */
function memoryStore(initial: { access: string; refresh: string; expiresAt: Date | null }, key = "conn-1") {
  const state = {
    access: initial.access,
    refresh: initial.refresh,
    expiresAt: initial.expiresAt,
    version: 1,
    leaseOwner: null as string | null,
    leaseUntil: 0,
    reauth: [] as string[],
    saves: 0,
    now: T0,
  };
  const store: TokenStore = {
    key,
    async read(): Promise<StoredTokens> {
      return { accessToken: state.access, refreshToken: state.refresh, expiresAt: state.expiresAt, cas: `${state.refresh}` };
    },
    async claim(owner, lease) {
      if (state.leaseOwner && state.leaseUntil > state.now && state.leaseOwner !== owner) return false;
      state.leaseOwner = owner;
      state.leaseUntil = state.now + lease * 1000;
      return true;
    },
    async saveRotated({ owner, expectedCas, tokens }: { owner: string; expectedCas: string; tokens: TokenSet }) {
      if (state.leaseOwner !== owner || state.leaseUntil < state.now || state.refresh !== expectedCas) return false;
      state.access = tokens.accessToken;
      state.refresh = tokens.refreshToken;
      state.expiresAt = tokens.expiresAt;
      state.version += 1;
      state.saves += 1;
      state.leaseOwner = null;
      return true;
    },
    async release(owner) {
      if (state.leaseOwner === owner) state.leaseOwner = null;
    },
    async markReauth(reason) {
      state.reauth.push(reason);
    },
  };
  return { store, state };
}

/**
 * A mocked Atlassian token endpoint that ROTATES: each refresh token works
 * once; using an old one is invalid_grant (what kills real connections).
 */
function atlassian(startRefresh: string) {
  let current = startRefresh;
  let n = 0;
  const used = new Set<string>();
  const calls: string[] = [];
  const refresh = vi.fn(async (args: { refreshToken: string }): Promise<TokenSet> => {
    calls.push(args.refreshToken);
    // a network hop, so concurrent callers really interleave
    await new Promise((r) => setTimeout(r, 5));
    if (args.refreshToken !== current || used.has(args.refreshToken)) throw new JiraAuthError("invalid_grant", 403);
    used.add(args.refreshToken);
    n += 1;
    current = `refresh-${n}`;
    return { accessToken: `access-${n}`, refreshToken: current, expiresAt: new Date(T0 + 3_600_000), scope: null };
  });
  return { refresh, calls };
}

const expired = new Date(T0 - 1000);

describe("TokenManager", () => {
  it("returns the stored token untouched while it is fresh (60 s skew)", async () => {
    const { store } = memoryStore({ access: "a0", refresh: "r0", expiresAt: new Date(T0 + 120_000) });
    const at = atlassian("r0");
    const tm = new TokenManager(store, CONFIG, { now: () => T0, refresh: at.refresh as never, inflight: new Map() });
    expect(await tm.getAccessToken()).toBe("a0");
    expect(at.refresh).not.toHaveBeenCalled();
  });

  it("refreshes inside the 60 s skew window and saves the rotated pair", async () => {
    const { store, state } = memoryStore({ access: "a0", refresh: "r0", expiresAt: new Date(T0 + 30_000) });
    const at = atlassian("r0");
    const tm = new TokenManager(store, CONFIG, { now: () => T0, refresh: at.refresh as never, inflight: new Map() });
    expect(await tm.getAccessToken()).toBe("access-1");
    expect(state.refresh).toBe("refresh-1");
    expect(state.access).toBe("access-1");
    expect(state.expiresAt?.getTime()).toBe(T0 + 3_600_000);
    expect(state.leaseOwner).toBeNull();
  });

  it("SINGLE FLIGHT in one process: 12 concurrent callers cause ONE refresh", async () => {
    const { store, state } = memoryStore({ access: "a0", refresh: "r0", expiresAt: expired });
    const at = atlassian("r0");
    const tm = new TokenManager(store, CONFIG, { now: () => T0, refresh: at.refresh as never, inflight: new Map() });
    const tokens = await Promise.all(Array.from({ length: 12 }, () => tm.getAccessToken()));
    expect(new Set(tokens)).toEqual(new Set(["access-1"]));
    expect(at.refresh).toHaveBeenCalledTimes(1);
    expect(state.saves).toBe(1);
  });

  it("SINGLE FLIGHT across processes: two managers racing on one connection refresh once, and neither loses the connection", async () => {
    const { store, state } = memoryStore({ access: "a0", refresh: "r0", expiresAt: expired });
    const at = atlassian("r0");
    // separate inflight maps = separate processes; only the database lease keeps them apart
    const mk = (owner: string) =>
      new TokenManager(store, CONFIG, { now: () => T0, refresh: at.refresh as never, inflight: new Map(), owner, pollMs: 1, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
    const a = mk("proc-a");
    const b = mk("proc-b");
    const results = await Promise.all([a.getAccessToken(), b.getAccessToken(), a.getAccessToken(), b.getAccessToken()]);
    expect(new Set(results).size).toBe(1);
    expect(at.refresh).toHaveBeenCalledTimes(1);
    expect(at.calls).toEqual(["r0"]); // the old refresh token was used exactly once
    expect(state.saves).toBe(1);
    expect(state.reauth).toEqual([]);
  });

  it("saves the ROTATED refresh token, so the next refresh uses the new one", async () => {
    const { store, state } = memoryStore({ access: "a0", refresh: "r0", expiresAt: expired });
    const at = atlassian("r0");
    let now = T0;
    const tm = new TokenManager(store, CONFIG, { now: () => now, refresh: at.refresh as never, inflight: new Map() });
    await tm.getAccessToken();
    now = T0 + 3_700_000; // an hour later the token has expired again
    state.now = now;
    expect(await tm.getAccessToken()).toBe("access-2");
    expect(at.calls).toEqual(["r0", "refresh-1"]);
    expect(state.refresh).toBe("refresh-2");
  });

  it("a dead lease holder does not block forever: another process takes over", async () => {
    const { store, state } = memoryStore({ access: "a0", refresh: "r0", expiresAt: expired });
    state.leaseOwner = "crashed";
    state.leaseUntil = T0 - 1; // its lease ran out
    const at = atlassian("r0");
    const tm = new TokenManager(store, CONFIG, { now: () => T0, refresh: at.refresh as never, inflight: new Map() });
    expect(await tm.getAccessToken()).toBe("access-1");
  });

  it("gives up waiting for a lease held by a live sibling that never finishes", async () => {
    const { store, state } = memoryStore({ access: "a0", refresh: "r0", expiresAt: expired });
    state.leaseOwner = "stuck";
    state.leaseUntil = T0 + 60_000;
    let now = T0;
    const tm = new TokenManager(store, CONFIG, {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      maxWaitMs: 1000,
      pollMs: 250,
      inflight: new Map(),
      refresh: (async () => {
        throw new Error("must not refresh without the lease");
      }) as never,
    });
    await expect(tm.getAccessToken()).rejects.toBeInstanceOf(JiraServerError);
  });

  it("marks the connection reauth_required when the refresh token is really dead", async () => {
    const { store, state } = memoryStore({ access: "a0", refresh: "r0", expiresAt: expired });
    const dead = vi.fn(async () => {
      throw new JiraAuthError("invalid_grant", 403);
    });
    const tm = new TokenManager(store, CONFIG, { now: () => T0, refresh: dead as never, inflight: new Map() });
    await expect(tm.getAccessToken()).rejects.toBeInstanceOf(JiraAuthError);
    expect(state.reauth).toEqual(["invalid_grant"]);
    expect(state.leaseOwner).toBeNull(); // the lease is always released
  });

  it("does NOT mark reauth when a sibling already rotated the token (invalid_grant is then only a lost race)", async () => {
    const { store, state } = memoryStore({ access: "a0", refresh: "r0", expiresAt: expired });
    const racing = vi.fn(async (): Promise<TokenSet> => {
      // a sibling saved fresh tokens while our request was in flight
      state.access = "sibling-access";
      state.refresh = "sibling-refresh";
      state.expiresAt = new Date(T0 + 3_600_000);
      throw new JiraAuthError("invalid_grant", 403);
    });
    const tm = new TokenManager(store, CONFIG, { now: () => T0, refresh: racing as never, inflight: new Map() });
    expect(await tm.getAccessToken()).toBe("sibling-access");
    expect(state.reauth).toEqual([]);
  });

  it("refreshes after a 401 with a token that still looks fresh (rejectedToken), unless somebody already replaced it", async () => {
    const { store, state } = memoryStore({ access: "a0", refresh: "r0", expiresAt: new Date(T0 + 3_000_000) });
    const at = atlassian("r0");
    const tm = new TokenManager(store, CONFIG, { now: () => T0, refresh: at.refresh as never, inflight: new Map() });
    expect(await tm.getAccessToken({ rejectedToken: "a0" })).toBe("access-1");
    // the same rejected token again: the stored one is already different, so no second refresh
    expect(await tm.getAccessToken({ rejectedToken: "a0" })).toBe("access-1");
    expect(at.refresh).toHaveBeenCalledTimes(1);
    expect(state.saves).toBe(1);
  });

  it("does not report success when the rotated pair could not be saved and nothing usable is stored", async () => {
    const { store, state } = memoryStore({ access: "a0", refresh: "r0", expiresAt: expired });
    const at = atlassian("r0");
    // the lease is stolen while the HTTP call is in flight
    const stolen = vi.fn(async (args: { refreshToken: string }) => {
      const t = await at.refresh(args);
      state.leaseOwner = "thief";
      state.leaseUntil = T0 + 30_000;
      return t;
    });
    const tm = new TokenManager(store, CONFIG, { now: () => T0, refresh: stolen as never, inflight: new Map() });
    await expect(tm.getAccessToken()).rejects.toBeInstanceOf(JiraServerError);
    expect(state.saves).toBe(0);
  });
});
