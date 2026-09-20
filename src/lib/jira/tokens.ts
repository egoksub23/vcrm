// ============================================================
// Access-token lifecycle for one Jira connection: single-flight refresh
// with an atomic save of the ROTATED refresh token.
//
// Atlassian rotates the refresh token on every use: the old one stops
// working (after a ten-minute reuse leeway), so two refreshes racing each
// other, or a refresh whose new token never got saved, kill the connection.
// Three layers prevent that:
//
//   1. In this process, callers for one connection share one in-flight
//      promise (a Map keyed by connection).
//   2. Across processes the database hands out a short lease
//      (jira_claim_refresh); whoever does not hold it waits and reads the
//      tokens the holder saved.
//   3. The save (jira_save_rotated_tokens) is one compare-and-swap that only
//      the lease holder, still holding the refresh token it started from, can
//      win.
//
// The store is an interface so the race is unit-tested against an in-memory
// store and a mocked HTTP layer; ./service.ts has the Supabase-backed one.
// ============================================================

import { randomUUID } from "node:crypto";

import { JiraAuthError, JiraServerError } from "./errors";
import { refreshTokens, type JiraOAuthConfig, type TokenSet } from "./oauth";
import { TOKEN_SKEW_MS } from "./types";

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date | null;
  /** Opaque compare-and-swap value: changes whenever the tokens are rotated. */
  cas: string;
}

export interface TokenStore {
  /** Stable key for the in-process single flight (the connection id). */
  readonly key: string;
  read(): Promise<StoredTokens>;
  /** Try to take the refresh lease. */
  claim(owner: string, leaseSeconds: number): Promise<boolean>;
  /** Save the rotated pair. False = the lease or the refresh token was no longer ours. */
  saveRotated(args: { owner: string; expectedCas: string; tokens: TokenSet }): Promise<boolean>;
  release(owner: string): Promise<void>;
  /** The refresh token is dead: flip the connection to reauth_required. */
  markReauth(reason: string): Promise<void>;
}

export interface TokenManagerDeps {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Lease holder id; unique per manager. */
  owner?: string;
  leaseSeconds?: number;
  /** How long a caller that did not get the lease waits for the holder. */
  maxWaitMs?: number;
  pollMs?: number;
  /** Override for tests that simulate several processes. */
  inflight?: Map<string, Promise<string>>;
  refresh?: typeof refreshTokens;
}

const sharedInflight = new Map<string, Promise<string>>();
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TokenManager {
  private readonly owner: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly inflight: Map<string, Promise<string>>;

  constructor(
    private readonly store: TokenStore,
    private readonly config: JiraOAuthConfig,
    private readonly deps: TokenManagerDeps = {},
  ) {
    this.owner = deps.owner ?? `tm-${randomUUID()}`;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.inflight = deps.inflight ?? sharedInflight;
  }

  private fresh(t: StoredTokens, rejected?: string): boolean {
    if (rejected && t.accessToken === rejected) return false;
    return !!t.expiresAt && t.expiresAt.getTime() - this.now() > TOKEN_SKEW_MS;
  }

  /**
   * A usable access token. `rejectedToken` is the token Jira just answered
   * 401 to: it is refreshed unless somebody already replaced it.
   */
  async getAccessToken(opts: { rejectedToken?: string } = {}): Promise<string> {
    const current = await this.store.read();
    if (this.fresh(current, opts.rejectedToken)) return current.accessToken;

    const pending = this.inflight.get(this.store.key);
    if (pending) return pending;

    const run = this.refreshOnce(opts.rejectedToken).finally(() => {
      if (this.inflight.get(this.store.key) === run) this.inflight.delete(this.store.key);
    });
    this.inflight.set(this.store.key, run);
    return run;
  }

  private async refreshOnce(rejected?: string): Promise<string> {
    const lease = this.deps.leaseSeconds ?? 30;
    const maxWait = this.deps.maxWaitMs ?? 10_000;
    const poll = this.deps.pollMs ?? 250;
    const started = this.now();

    for (;;) {
      if (await this.store.claim(this.owner, lease)) {
        try {
          return await this.refreshHoldingLease(rejected);
        } finally {
          await this.store.release(this.owner).catch(() => undefined);
        }
      }
      // Someone else is refreshing: wait for their save, then use it.
      const cur = await this.store.read();
      if (this.fresh(cur, rejected)) return cur.accessToken;
      if (this.now() - started >= maxWait) {
        throw new JiraServerError("Another refresh of the Jira token is taking too long", 503);
      }
      await this.sleep(poll);
    }
  }

  private async refreshHoldingLease(rejected?: string): Promise<string> {
    // Another process may have finished while this one waited for the lease.
    const cur = await this.store.read();
    if (this.fresh(cur, rejected)) return cur.accessToken;

    const doRefresh = this.deps.refresh ?? refreshTokens;
    let tokens: TokenSet;
    try {
      tokens = await doRefresh(
        { refreshToken: cur.refreshToken, config: this.config },
        { fetch: this.deps.fetch, now: this.now },
      );
    } catch (err) {
      if (err instanceof JiraAuthError) {
        // If the refresh token changed under us, a sibling already rotated it: use theirs.
        const after = await this.store.read();
        if (after.cas !== cur.cas && this.fresh(after)) return after.accessToken;
        await this.store.markReauth(err.message || "refresh token rejected");
      }
      throw err;
    }

    const saved = await this.store.saveRotated({ owner: this.owner, expectedCas: cur.cas, tokens });
    if (saved) return tokens.accessToken;

    // The pair we hold could not be saved (the lease lapsed and someone else
    // rotated). What is stored now is what counts.
    const after = await this.store.read();
    if (this.fresh(after)) return after.accessToken;
    throw new JiraServerError("The refreshed Jira token could not be saved; try again", 503);
  }
}
