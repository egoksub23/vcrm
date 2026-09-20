import { createHmac } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it } from "vitest";

import { catchupStall, CATCHUP_STALL_MINUTES } from "./catchup";
import { CHECKLIST_STEPS, computeChecklist, nextChecklistStep } from "./checklist";
import { checkCatchupStall, REPORT_RETRY_MS, runCron, runWeekly, type CronContext, type CronDeps } from "./cron";
import { normalizeSettings } from "./settings";
import { connectionRow, fakeClient, linkRow, MemoryStore } from "./test-fakes";
import { authorizeWebhook } from "./webhook";
import { __resetWebhookNotesForTests, handleWebhook, type WebhookRequest, type WebhookStore } from "./webhook-handler";
import { DEFAULT_JIRA_SETTINGS, type JiraConnectionRow } from "./types";

const SECRET = "app-client-secret";
const NOW = Date.parse("2026-09-20T10:00:00Z");
const TOKEN = "tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
const min = (m: number) => new Date(NOW - m * 60_000).toISOString();

function jwt(payload: object, secret = SECRET) {
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${h}.${p}.${createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")}`;
}

// ------------------------------------------------------------------
// 1. Webhook trust: "Require signed deliveries" and the counters
// ------------------------------------------------------------------

describe("authorizeWebhook with require-signed", () => {
  const base = { pathToken: TOKEN, expectedToken: TOKEN, clientSecret: SECRET, now: NOW };

  it("off (the default): the secret address alone is enough, as before", () => {
    expect(authorizeWebhook({ ...base, authorization: null })).toEqual({ ok: true, level: "token_only" });
    expect(authorizeWebhook({ ...base, authorization: null, requireSigned: false })).toEqual({ ok: true, level: "token_only" });
  });

  it("on: no bearer is refused, a verifying bearer is accepted, a forged one is refused", () => {
    expect(authorizeWebhook({ ...base, authorization: null, requireSigned: true })).toEqual({ ok: false, reason: "unsigned" });
    expect(authorizeWebhook({ ...base, authorization: `Bearer ${jwt({ exp: NOW / 1000 + 60 })}`, requireSigned: true })).toEqual({ ok: true, level: "jwt" });
    expect(authorizeWebhook({ ...base, authorization: `Bearer ${jwt({}, "other")}`, requireSigned: true })).toEqual({ ok: false, reason: "bad_bearer" });
  });

  it("on: never falls back to the address alone, even with JIRA_WEBHOOK_VERIFY=path-only or no app secret", () => {
    expect(authorizeWebhook({ ...base, authorization: `Bearer ${jwt({})}`, requireSigned: true, verifyMode: "path-only" })).toEqual({ ok: false, reason: "unsigned" });
    expect(authorizeWebhook({ ...base, authorization: `Bearer ${jwt({})}`, requireSigned: true, clientSecret: null })).toEqual({ ok: false, reason: "unsigned" });
  });

  it("the path token is still checked first", () => {
    expect(authorizeWebhook({ ...base, pathToken: "wrong", authorization: `Bearer ${jwt({})}`, requireSigned: true })).toEqual({ ok: false, reason: "bad_token" });
  });
});

describe("handleWebhook: strict mode and the delivery counters", () => {
  let store: MemoryStore;
  const seen = new Set<string>();
  const hooks = (conn: JiraConnectionRow): WebhookStore => ({
    async connectionByToken(t) {
      return t === TOKEN ? { connection: conn, expectedToken: TOKEN } : null;
    },
    async recordDelivery(id, d) {
      const k = `${id}:${d}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    },
  });
  const body = JSON.stringify({ webhookEvent: "jira:issue_updated", issue: { id: "10001", key: "ENG-1" } });
  const req = (over: Partial<WebhookRequest> = {}): WebhookRequest => ({ pathToken: TOKEN, authorization: null, identifier: "d1", rawBody: body, clientSecret: SECRET, now: NOW, ...over });
  const run = (r: WebhookRequest) => handleWebhook(r, { hooks: hooks(store.connections[0]), store, limit: (() => ({ success: true, remaining: 1, reset: 0, limit: 1 })) as never });

  beforeEach(() => {
    __resetWebhookNotesForTests();
    seen.clear();
    store = new MemoryStore();
    store.links.push(linkRow({ issue_id: "10001", issue_key: "ENG-1" }));
  });

  it("counts deliveries by how they arrived, so Diagnostics can show which mode real deliveries use", async () => {
    await run(req({ identifier: "a" }));
    await run(req({ identifier: "b" }));
    await run(req({ identifier: "c", authorization: `Bearer ${jwt({ exp: NOW / 1000 + 60 })}` }));
    expect(store.webhookStats.map((s) => s.kind)).toEqual(["unsigned", "unsigned", "signed"]);
  });

  it("with 'Require signed deliveries' on, an unsigned delivery is refused (401), counted, noted once and never queued", async () => {
    store.connections[0].settings = { webhook: { require_signed: true } };
    const r1 = await run(req({ identifier: "u1" }));
    const r2 = await run(req({ identifier: "u2" }));
    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);
    expect(store.jobs).toEqual([]);
    expect(store.webhookStats.map((s) => s.kind)).toEqual(["rejected_unsigned", "rejected_unsigned"]);
    expect(store.events.filter((e) => e.kind === "webhook_unsigned_rejected")).toHaveLength(1);
    // a signed one still gets through
    const ok = await run(req({ identifier: "s1", authorization: `Bearer ${jwt({ exp: NOW / 1000 + 60 })}` }));
    expect(ok).toEqual({ status: 200, body: { queued: true } });
    expect(store.webhookStats.at(-1)?.kind).toBe("signed");
  });

  it("with it off (the default) nothing changes for an unsigned delivery", async () => {
    expect((await run(req())).status).toBe(200);
    expect(normalizeSettings(store.connections[0].settings).webhook.require_signed).toBe(false);
  });
});

// ------------------------------------------------------------------
// 2. The personal-data report: result, "Send now", back-off
// ------------------------------------------------------------------

function fakeDb(rows: Record<string, unknown[]> = {}) {
  const db = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      for (const op of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "in", "not", "is", "order", "limit", "maybeSingle", "single"]) chain[op] = () => chain;
      chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows[table] ?? [], error: null });
      return chain;
    },
  };
  return db as unknown as SupabaseClient;
}

function deps(store: MemoryStore, client: unknown, over: Partial<CronDeps> = {}): CronDeps {
  return {
    db: fakeDb({ jira_user_map: [{ jira_account_id: "acct-7" }] }),
    store,
    baseUrl: "https://crm.example.com",
    readWebhookToken: async () => null,
    contextFor: (connection): CronContext => ({ store, client: client as never, connection, settings: { ...DEFAULT_JIRA_SETTINGS }, appUrl: "", now: () => NOW }),
    now: () => NOW,
    ...over,
  };
}

describe("personal-data report: last result and Send now", () => {
  const reporting = (script: () => Promise<{ accountId: string; status: string }[]>) => ({ ...fakeClient().client, reportAccounts: async () => script() });

  it("records the result on the connection", async () => {
    const store = new MemoryStore();
    const r = await runWeekly(deps(store, reporting(async () => [])), store.connections[0]);
    expect(r.ran).toBe(true);
    expect(store.connections[0].last_report_result).toMatchObject({ ok: true, at: new Date(NOW).toISOString(), reported: expect.any(Number) });
    expect(store.connections[0].last_report_at).toBe(new Date(NOW).toISOString());
  });

  it("Send now (force) runs even when the report ran a minute ago or the weekly report is switched off", async () => {
    const store = new MemoryStore();
    store.connections[0].last_report_at = min(1);
    store.connections[0].settings = { personal_data_report: false };
    expect((await runWeekly(deps(store, reporting(async () => [])), store.connections[0])).ran).toBe(false);
    expect((await runWeekly(deps(store, reporting(async () => [])), store.connections[0], { force: true })).ran).toBe(true);
  });

  it("a failing report is stored as a failure and NOT retried on every cron call (it used to hammer Atlassian)", async () => {
    const store = new MemoryStore();
    let calls = 0;
    const failing = reporting(async () => {
      calls += 1;
      throw new Error("Atlassian answered 500");
    });
    await expect(runWeekly(deps(store, failing), store.connections[0])).rejects.toThrow("500");
    expect(store.connections[0].last_report_result).toMatchObject({ ok: false, error: expect.stringContaining("500") });
    expect(store.connections[0].last_report_at).toBeNull(); // not marked as sent
    // the next cron call (a minute later) does not try again ...
    const later = deps(store, failing, { now: () => NOW + 60_000 });
    expect((await runWeekly(later, store.connections[0])).ran).toBe(false);
    expect(calls).toBe(1);
    // ... a few hours later it does, and Send now always may
    const hours = deps(store, failing, { now: () => NOW + REPORT_RETRY_MS + 1000 });
    await expect(runWeekly(hours, store.connections[0])).rejects.toThrow();
    expect(calls).toBe(2);
    await expect(runWeekly(later, store.connections[0], { force: true })).rejects.toThrow();
    expect(calls).toBe(3);
  });
});

// ------------------------------------------------------------------
// 3. The catch-up self-check
// ------------------------------------------------------------------

describe("catchupStall (pure)", () => {
  const stall = (over: Partial<Parameters<typeof catchupStall>[0]>) => catchupStall({ lastCatchupAt: min(10), liveLinkCreatedAt: [min(3 * 24 * 60)], now: NOW, ...over });

  it("is fine within 30 minutes and stalled after", () => {
    expect(CATCHUP_STALL_MINUTES).toBe(30);
    expect(stall({ lastCatchupAt: min(10) })).toEqual({ stalled: false, minutes: 10 });
    expect(stall({ lastCatchupAt: min(30) }).stalled).toBe(false);
    expect(stall({ lastCatchupAt: min(31) })).toEqual({ stalled: true, minutes: 31 });
  });

  it("no live links means nothing to catch up", () => {
    expect(stall({ liveLinkCreatedAt: [] })).toEqual({ stalled: false, minutes: null });
  });

  it("a link created a minute ago cannot have missed a catch-up, however old the last one is", () => {
    expect(stall({ lastCatchupAt: min(5 * 24 * 60), liveLinkCreatedAt: [min(1)] })).toEqual({ stalled: false, minutes: 1 });
  });

  it("never caught up: measured from the oldest live link", () => {
    expect(stall({ lastCatchupAt: null, liveLinkCreatedAt: [min(90), min(5)] })).toEqual({ stalled: true, minutes: 90 });
    expect(stall({ lastCatchupAt: null, liveLinkCreatedAt: [min(20)] }).stalled).toBe(false);
  });

  it("ignores unparseable times and honours a custom threshold", () => {
    expect(stall({ lastCatchupAt: "not a date", liveLinkCreatedAt: [min(40)] }).stalled).toBe(true);
    expect(stall({ lastCatchupAt: min(10), thresholdMinutes: 5 }).stalled).toBe(true);
  });
});

describe("checkCatchupStall and the cron run", () => {
  it("alerts the owners (once, through the store) and logs an error when live links have gone 30 minutes without a catch-up", async () => {
    const store = new MemoryStore();
    store.connections[0] = connectionRow({ last_catchup_at: min(45) });
    store.links.push(linkRow({ created_at: min(3 * 24 * 60) }));
    const r = await checkCatchupStall(deps(store, fakeClient().client), store.connections[0]);
    expect(r).toEqual({ stalled: true, minutes: 45, notified: 1 });
    expect(store.stalled).toEqual([{ id: "conn-1", minutes: 45 }]);
    expect(store.events.find((e) => e.kind === "catchup_stalled")).toMatchObject({ level: "error", message: expect.stringContaining("45 minutes") });
  });

  it("stays quiet when the catch-up is recent, when there are no live links, and when the alert already went out today", async () => {
    const quiet = new MemoryStore();
    quiet.links.push(linkRow({ created_at: min(3 * 24 * 60) }));
    quiet.connections[0].last_catchup_at = min(6);
    expect((await checkCatchupStall(deps(quiet, fakeClient().client), quiet.connections[0])).stalled).toBe(false);
    expect(quiet.stalled).toEqual([]);

    const none = new MemoryStore();
    none.connections[0].last_catchup_at = min(500);
    expect((await checkCatchupStall(deps(none, fakeClient().client), none.connections[0])).stalled).toBe(false);

    const dup = new MemoryStore();
    dup.connections[0].last_catchup_at = min(60);
    dup.links.push(linkRow({ created_at: min(3 * 24 * 60) }));
    dup.notifyStalled = async () => 0; // the SQL function found today's alert already sent
    const r = await checkCatchupStall(deps(dup, fakeClient().client), dup.connections[0]);
    expect(r).toMatchObject({ stalled: true, notified: 0 });
    expect(dup.events.some((e) => e.kind === "catchup_stalled")).toBe(false);
  });

  it("runCron reports stalled connections, and a catch-up that just succeeded is not a false alarm", async () => {
    const stalled = new MemoryStore();
    stalled.connections[0] = connectionRow({ last_catchup_at: min(3) }); // recent, so catch-up is skipped (5 min spacing)
    stalled.links.push(linkRow({ created_at: min(3 * 24 * 60) }));
    expect((await runCron(deps(stalled, fakeClient().client))).catchup.stalled).toBe(0);

    // last catch-up 60 minutes ago: the cron's own catch-up runs FIRST and succeeds, then the check re-reads the connection
    const recovers = new MemoryStore();
    recovers.connections[0] = connectionRow({ last_catchup_at: min(60) });
    recovers.links.push(linkRow({ created_at: min(3 * 24 * 60) }));
    const fake = fakeClient({ searchIssues: async () => ({ issues: [] }) });
    const report = await runCron(deps(recovers, fake.client));
    expect(report.catchup.connections).toBe(1);
    expect(report.catchup.stalled).toBe(0);
    expect(recovers.stalled).toEqual([]);

    // the catch-up FAILS (Jira down): the connection stays stalled and the owners are told
    const failing = new MemoryStore();
    failing.connections[0] = connectionRow({ last_catchup_at: min(60) });
    failing.links.push(linkRow({ created_at: min(3 * 24 * 60) }));
    const down = fakeClient({ searchIssues: async () => { throw new Error("Jira down"); } });
    const r2 = await runCron(deps(failing, down.client));
    expect(r2.catchup.failed).toBe(1);
    expect(r2.catchup.stalled).toBe(1);
    expect(failing.stalled).toHaveLength(1);
  });
});

// ------------------------------------------------------------------
// 4. The first-run checklist
// ------------------------------------------------------------------

describe("first-run checklist", () => {
  const conn = (over: Partial<JiraConnectionRow> = {}) => ({ status: "active" as const, webhook_ids: [] as unknown, last_catchup_at: null as string | null, ...over });
  const facts = (over: Partial<Parameters<typeof computeChecklist>[0]> = {}) => ({
    configured: true,
    connection: conn(),
    settings: { projects: { allowed: [] as string[], default_project: null, default_issue_type: null } },
    syncEvidence: false,
    ...over,
  });
  const done = (f: ReturnType<typeof facts>) => Object.fromEntries(computeChecklist(f).map((s) => [s.id, s.done]));

  it("lists the five steps in order", () => {
    expect(computeChecklist(facts()).map((s) => s.id)).toEqual([...CHECKLIST_STEPS]);
    expect([...CHECKLIST_STEPS]).toEqual(["credentials", "connected", "project", "webhook", "sync"]);
  });

  it("turns green one step at a time", () => {
    expect(done(facts({ configured: false, connection: null }))).toEqual({ credentials: false, connected: false, project: false, webhook: false, sync: false });
    expect(done(facts({ connection: null }))).toEqual({ credentials: true, connected: false, project: false, webhook: false, sync: false });
    expect(done(facts())).toEqual({ credentials: true, connected: true, project: false, webhook: false, sync: false });
    const withProject = facts({ settings: { projects: { allowed: ["ENG"], default_project: null, default_issue_type: null } } });
    expect(done(withProject)).toMatchObject({ project: true, webhook: false });
    expect(done(facts({ settings: { projects: { allowed: [], default_project: "ENG", default_issue_type: null } } }))).toMatchObject({ project: true });
    expect(done({ ...withProject, connection: conn({ webhook_ids: [1001] }) })).toMatchObject({ webhook: true, sync: false });
    expect(done({ ...withProject, connection: conn({ webhook_ids: [1001], last_catchup_at: min(2) }) })).toEqual({ credentials: true, connected: true, project: true, webhook: true, sync: true });
  });

  it("a webhook delivery or a finished sync job also proves the first sync", () => {
    expect(done(facts({ syncEvidence: true }))).toMatchObject({ sync: true });
  });

  it("a connection that needs reconnecting or was disconnected fails everything after 'credentials'", () => {
    const allowed = { projects: { allowed: ["ENG"], default_project: null, default_issue_type: null } };
    expect(done(facts({ connection: conn({ status: "reauth_required", webhook_ids: [1], last_catchup_at: min(1) }), settings: allowed }))).toEqual({ credentials: true, connected: false, project: false, webhook: false, sync: false });
    expect(done(facts({ connection: conn({ status: "revoked" as never }), settings: allowed })).connected).toBe(false);
  });

  it("names the next step to do", () => {
    expect(nextChecklistStep(computeChecklist(facts()))).toBe("project");
    const all = computeChecklist(facts({ connection: conn({ webhook_ids: [1], last_catchup_at: min(1) }), settings: { projects: { allowed: ["ENG"], default_project: null, default_issue_type: null } } }));
    expect(nextChecklistStep(all)).toBeNull();
  });
});
