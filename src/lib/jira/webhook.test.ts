import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { issue, linkRow, MemoryStore } from "./test-fakes";
import {
  authorizeWebhook,
  deliveryKey,
  extractBearer,
  parseWebhookPayload,
  payloadMatchesSite,
  safeEqual,
  verifyHs256Jwt,
} from "./webhook";
import { __resetWebhookNotesForTests, handleWebhook, type WebhookRequest, type WebhookStore } from "./webhook-handler";
import type { JiraConnectionRow } from "./types";

const SECRET = "app-client-secret";
const NOW = Date.parse("2026-09-20T10:00:00Z");
const TOKEN = "tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";

function jwt(payload: object, secret = SECRET, alg = "HS256") {
  const h = Buffer.from(JSON.stringify({ alg, typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const s = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}

describe("bearer verification", () => {
  it("extracts a bearer token", () => {
    expect(extractBearer("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(extractBearer("bearer x")).toBe("x");
    expect(extractBearer("Basic abc")).toBeNull();
    expect(extractBearer(null)).toBeNull();
    expect(extractBearer("Bearer a b")).toBeNull();
  });

  it("verifies an HS256 JWT signed with the app secret", () => {
    expect(verifyHs256Jwt(jwt({ exp: NOW / 1000 + 600 }), SECRET, NOW)).toEqual({ ok: true });
    expect(verifyHs256Jwt(jwt({}), SECRET, NOW)).toEqual({ ok: true }); // no exp: nothing to check
  });

  it("rejects a wrong secret, a tampered payload, alg none, another alg, an expired token and garbage", () => {
    expect(verifyHs256Jwt(jwt({ a: 1 }, "other-secret"), SECRET, NOW)).toMatchObject({ ok: false, reason: "signature" });
    const good = jwt({ a: 1 });
    const [h, , s] = good.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ a: 2 })).toString("base64url")}.${s}`;
    expect(verifyHs256Jwt(forged, SECRET, NOW)).toMatchObject({ ok: false, reason: "signature" });
    const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from("{}").toString("base64url")}.`;
    expect(verifyHs256Jwt(none, SECRET, NOW)).toMatchObject({ ok: false });
    expect(verifyHs256Jwt(jwt({ a: 1 }, SECRET, "HS512"), SECRET, NOW)).toMatchObject({ ok: false, reason: "alg" });
    expect(verifyHs256Jwt(jwt({ exp: NOW / 1000 - 3600 }), SECRET, NOW)).toMatchObject({ ok: false, reason: "expired" });
    expect(verifyHs256Jwt("a.b", SECRET, NOW)).toMatchObject({ ok: false, reason: "malformed" });
    expect(verifyHs256Jwt("not-a-jwt", SECRET, NOW)).toMatchObject({ ok: false });
    expect(verifyHs256Jwt(good, "", NOW)).toMatchObject({ ok: false });
  });

  it("constant-time compare handles different lengths", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("authorizeWebhook", () => {
  const args = { pathToken: TOKEN, expectedToken: TOKEN, authorization: null as string | null, clientSecret: SECRET, now: NOW };

  it("needs the path token, always", () => {
    expect(authorizeWebhook({ ...args, pathToken: "wrong" })).toEqual({ ok: false, reason: "bad_token" });
    expect(authorizeWebhook({ ...args, expectedToken: null })).toEqual({ ok: false, reason: "bad_token" });
    // a valid bearer cannot stand in for the path token
    expect(authorizeWebhook({ ...args, pathToken: "wrong", authorization: `Bearer ${jwt({})}` })).toEqual({ ok: false, reason: "bad_token" });
  });

  it("accepts the token alone (token_only) and a valid bearer (jwt)", () => {
    expect(authorizeWebhook(args)).toEqual({ ok: true, level: "token_only" });
    expect(authorizeWebhook({ ...args, authorization: `Bearer ${jwt({})}` })).toEqual({ ok: true, level: "jwt" });
  });

  it("rejects a bearer that does not verify, unless verification is switched to path-only", () => {
    const bad = `Bearer ${jwt({}, "other")}`;
    expect(authorizeWebhook({ ...args, authorization: bad })).toEqual({ ok: false, reason: "bad_bearer" });
    expect(authorizeWebhook({ ...args, authorization: bad, verifyMode: "path-only" })).toEqual({ ok: true, level: "token_only" });
  });
});

describe("payload parsing", () => {
  it("reads the parts we use", () => {
    const p = parseWebhookPayload({
      webhookEvent: "jira:issue_updated",
      timestamp: 1758362400000,
      issue: { id: "10001", key: "ENG-1", self: "https://acme.atlassian.net/rest/api/2/issue/10001" },
      changelog: { items: [{ field: "status" }, { fieldId: "assignee" }, {}] },
      comment: { id: 77 },
    });
    expect(p).toEqual({
      event: "jira:issue_updated",
      issueId: "10001",
      issueKey: "ENG-1",
      commentId: "77",
      timestamp: 1758362400000,
      changedFields: ["status", "assignee"],
      self: "https://acme.atlassian.net/rest/api/2/issue/10001",
    });
  });

  it("never throws on hostile shapes", () => {
    for (const body of [null, undefined, 5, "x", [], { issue: "no", comment: [], changelog: { items: "nope" } }, { issue: { id: {} } }]) {
      expect(() => parseWebhookPayload(body)).not.toThrow();
    }
    expect(parseWebhookPayload(null).event).toBe("unknown");
  });

  it("cross-checks the site the payload names", () => {
    const site = "https://acme.atlassian.net";
    const cloud = "11111111-2222-4333-8444-555555555555";
    expect(payloadMatchesSite("https://acme.atlassian.net/rest/api/2/issue/1", site, cloud)).toBe(true);
    expect(payloadMatchesSite("https://other.atlassian.net/rest/api/2/issue/1", site, cloud)).toBe(false);
    expect(payloadMatchesSite(`https://api.atlassian.com/ex/jira/${cloud}/rest/api/2/issue/1`, site, cloud)).toBe(true);
    expect(payloadMatchesSite("https://api.atlassian.com/ex/jira/99999999-2222-4333-8444-555555555555/x", site, cloud)).toBe(false);
    expect(payloadMatchesSite(null, site, cloud)).toBe(true);
    expect(payloadMatchesSite("not a url", site, cloud)).toBe(false);
  });

  it("de-duplicates on Atlassian's identifier, or on the body when there is none", () => {
    expect(deliveryKey("abc-123", "{}")).toBe("abc-123");
    expect(deliveryKey(null, '{"a":1}')).toBe(deliveryKey("", '{"a":1}'));
    expect(deliveryKey(null, '{"a":1}')).not.toBe(deliveryKey(null, '{"a":2}'));
    expect(deliveryKey("x".repeat(500), "{}")).toMatch(/^body:/);
  });
});

// ------------------------------------------------------------------
// The receiver end to end, against the in-memory store
// ------------------------------------------------------------------

function hooksFor(store: MemoryStore, connection: JiraConnectionRow): WebhookStore & { seen: Set<string> } {
  const seen = new Set<string>();
  return {
    seen,
    async connectionByToken(token) {
      return token === TOKEN ? { connection, expectedToken: TOKEN } : null;
    },
    async recordDelivery(connId, id) {
      const key = `${connId}:${id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  };
}

const body = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    webhookEvent: "jira:issue_updated",
    issue: { id: "10001", key: "ENG-1", self: "https://acme.atlassian.net/rest/api/2/issue/10001" },
    ...over,
  });

const req = (over: Partial<WebhookRequest> = {}): WebhookRequest => ({
  pathToken: TOKEN,
  authorization: null,
  identifier: "delivery-1",
  rawBody: body(),
  clientSecret: SECRET,
  now: NOW,
  ...over,
});

describe("handleWebhook", () => {
  let store: MemoryStore;
  let hooks: ReturnType<typeof hooksFor>;
  const ok = { success: true, remaining: 1, reset: 0, limit: 1 };
  const deps = () => ({ hooks, store, limit: (() => ok) as never });

  beforeEach(() => {
    __resetWebhookNotesForTests();
    store = new MemoryStore();
    store.links.push(linkRow({ issue_id: "10001", issue_key: "ENG-1" }));
    hooks = hooksFor(store, store.connections[0]);
  });

  it("queues 'sync issue X' and answers 200", async () => {
    const r = await handleWebhook(req(), deps());
    expect(r).toEqual({ status: 200, body: { queued: true } });
    expect(store.jobs).toHaveLength(1);
    expect(store.jobs[0]).toMatchObject({ kind: "sync_issue", payload: { issue_id: "10001", event: "jira:issue_updated", comments: false }, dedupe: "sync:10001" });
  });

  it("reads comments too for a comment event", async () => {
    await handleWebhook(req({ rawBody: body({ webhookEvent: "comment_created", comment: { id: "5" } }), identifier: "d2" }), deps());
    expect(store.jobs[0].payload.comments).toBe(true);
  });

  it("de-duplicates by delivery id (Atlassian retries)", async () => {
    await handleWebhook(req(), deps());
    const again = await handleWebhook(req(), deps());
    expect(again).toEqual({ status: 200, body: { duplicate: true } });
    expect(store.jobs).toHaveLength(1);
  });

  it("coalesces a burst for one issue into one queued job", async () => {
    for (let i = 0; i < 5; i++) await handleWebhook(req({ identifier: `burst-${i}` }), deps());
    expect(store.jobs).toHaveLength(1);
  });

  it("rejects a wrong or malformed token without touching anything", async () => {
    expect((await handleWebhook(req({ pathToken: "short" }), deps())).status).toBe(404);
    expect((await handleWebhook(req({ pathToken: "x".repeat(40) }), deps())).status).toBe(404);
    expect(store.jobs).toHaveLength(0);
  });

  it("rejects a bearer that does not verify (401) and never queues", async () => {
    const r = await handleWebhook(req({ authorization: `Bearer ${jwt({}, "forged-secret")}` }), deps());
    expect(r.status).toBe(401);
    expect(store.jobs).toHaveLength(0);
    expect(store.events.some((e) => e.kind === "webhook_bearer_rejected")).toBe(true);
  });

  it("accepts a valid bearer", async () => {
    expect((await handleWebhook(req({ authorization: `Bearer ${jwt({ exp: NOW / 1000 + 60 })}` }), deps())).status).toBe(200);
    expect(store.events.some((e) => e.kind === "webhook_token_only")).toBe(false);
  });

  it("logs the token-only uncertainty prominently, once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await handleWebhook(req({ identifier: "a" }), deps());
    await handleWebhook(req({ identifier: "b" }), deps());
    expect(store.events.filter((e) => e.kind === "webhook_token_only")).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("drops events for issues nobody linked (a project-wide filter delivers those too)", async () => {
    const r = await handleWebhook(req({ rawBody: body({ issue: { id: "99999", key: "ENG-99" } }), identifier: "x" }), deps());
    expect(r).toEqual({ status: 200, body: { ignored: "not_linked" } });
    expect(store.jobs).toHaveLength(0);
  });

  it("finds the linked issue by key when the payload has no id", async () => {
    const r = await handleWebhook(req({ rawBody: body({ issue: { key: "ENG-1" } }), identifier: "k" }), deps());
    expect(r.body).toEqual({ queued: true });
    expect(store.jobs[0].payload.issue_id).toBe("10001");
  });

  it("ignores events it does not handle, a payload for another site, and an inactive connection", async () => {
    expect((await handleWebhook(req({ rawBody: body({ webhookEvent: "sprint_started" }), identifier: "e" }), deps())).body).toEqual({ ignored: "event" });
    const wrongSite = body({ issue: { id: "10001", key: "ENG-1", self: "https://evil.atlassian.net/rest/api/2/issue/10001" } });
    expect((await handleWebhook(req({ rawBody: wrongSite, identifier: "s" }), deps())).body).toEqual({ ignored: "site" });
    store.connections[0].status = "reauth_required";
    expect((await handleWebhook(req({ identifier: "i" }), deps())).body).toEqual({ ignored: "connection_inactive" });
    expect(store.jobs).toHaveLength(0);
  });

  it("answers 400 for a body that is not JSON, and refuses huge bodies and rate-limited callers", async () => {
    expect((await handleWebhook(req({ rawBody: "{not json", identifier: "j" }), deps())).status).toBe(400);
    expect((await handleWebhook(req({ rawBody: "x".repeat(1_100_000), identifier: "big" }), deps())).status).toBe(413);
    const limited = await handleWebhook(req(), { ...deps(), limit: (() => ({ success: false, remaining: 0, reset: 0, limit: 1 })) as never });
    expect(limited.status).toBe(429);
  });

  it("NEVER acts on the payload alone: a forged 'Done' in the body changes nothing, it only queues a re-read", async () => {
    const forged = body({
      issue: { id: "10001", key: "ENG-1", fields: { status: { name: "Done", statusCategory: { key: "done" } } } },
      changelog: { items: [{ field: "status", toString: "Done" }] },
    });
    await handleWebhook(req({ rawBody: forged, identifier: "f" }), deps());
    expect(store.tickets[0].status).toBe("open");
    expect(store.links[0].status_name).toBe("To Do");
    expect(store.appliedStatuses).toEqual([]);
    expect(JSON.stringify(store.jobs)).not.toContain("Done"); // the payload's content is not even queued
    expect(issue().id).toBe("10001");
  });
});
