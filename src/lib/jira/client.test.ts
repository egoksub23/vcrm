import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  backoffMs,
  engageGlobalBrake,
  globalBrakeRemaining,
  JiraClient,
  parseRetryAfter,
  resetGlobalBrake,
} from "./client";
import {
  JiraAuthError,
  JiraConfigError,
  JiraNetworkError,
  JiraNotFoundError,
  JiraPermissionError,
  JiraRateLimitError,
  JiraServerError,
  JiraValidationError,
} from "./errors";

const CLOUD = "11111111-2222-4333-8444-555555555555";
const NOW = Date.parse("2026-09-20T10:00:00Z");

function res(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function make(responses: (Response | Error)[] | ((url: string, init: RequestInit) => Response | Promise<Response>), over: Partial<ConstructorParameters<typeof JiraClient>[0]> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const sleeps: number[] = [];
  let i = 0;
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (typeof responses === "function") return responses(url, init);
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r.clone();
  });
  const tokens: (string | undefined)[] = [];
  const client = new JiraClient({
    cloudId: CLOUD,
    connectionKey: `k-${Math.random()}`,
    fetch: fetchFn as never,
    getAccessToken: async (o) => {
      tokens.push(o?.rejectedToken);
      return o?.rejectedToken ? "token-2" : "token-1";
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => NOW,
    random: () => 0.5,
    ...over,
  });
  return { client, calls, sleeps, fetchFn, tokens };
}

beforeEach(() => resetGlobalBrake());
afterEach(() => resetGlobalBrake());

describe("URL and safety", () => {
  it("always talks to api.atlassian.com/ex/jira/{cloudId}/rest/api/3", async () => {
    const { client, calls } = make([res(200, { accountId: "a" })]);
    await client.getMyself();
    expect(calls[0].url).toBe(`https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/myself`);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer token-1");
  });

  it("refuses a cloud id that is not a UUID", () => {
    for (const bad of ["", "abc", "../x", `${CLOUD}/../../evil`, "evil.example.com"]) {
      expect(() => new JiraClient({ cloudId: bad, getAccessToken: async () => "t" })).toThrow(JiraConfigError);
    }
  });

  it("refuses paths that could leave the API", async () => {
    const { client, fetchFn } = make([res(200, {})]);
    for (const p of ["issue/1", "/../admin", "https://evil.example/x", "/issue/1?x=1", "/a#b", "//evil.example"]) {
      await expect(client.request("GET", p)).rejects.toBeInstanceOf(JiraConfigError);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("encodes issue keys, and refuses a key that tries to climb out of the path", async () => {
    const { client, calls } = make([res(200, { id: "1", key: "ENG-1", fields: {} })]);
    await client.getIssue("ENG-1/x y");
    expect(calls[0].url).toContain("/issue/ENG-1%2Fx%20y?");
    await expect(client.getIssue("ENG-1/../../x")).rejects.toBeInstanceOf(JiraConfigError);
    expect(calls).toHaveLength(1);
  });

  it("NEVER deletes Jira data: DELETE is refused except for its own webhooks", async () => {
    const { client, fetchFn } = make([res(204)]);
    await expect(client.request("DELETE", "/issue/ENG-1")).rejects.toThrow(/never deletes/);
    await expect(client.request("DELETE", "/issue/10001/comment/1")).rejects.toThrow(/never deletes/);
    await expect(client.request("DELETE", "/project/ENG")).rejects.toThrow(/never deletes/);
    expect(fetchFn).not.toHaveBeenCalled();
    await expect(client.deleteWebhooks([1])).resolves.toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("never requests the removed /search endpoint", async () => {
    const { client, calls } = make([res(200, { issues: [] })]);
    await client.searchIssues({ jql: "id in (1)" });
    expect(calls[0].url).toMatch(/\/rest\/api\/3\/search\/jql$/);
    expect(calls[0].url).not.toMatch(/\/search$/);
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ jql: "id in (1)" });
  });

  it("asks for specific fields only and chunks a bulk fetch at 100", async () => {
    const { client, calls } = make([res(200, { issues: [] })]);
    await client.bulkFetch(Array.from({ length: 250 }, (_, i) => String(i + 1)));
    expect(calls).toHaveLength(3);
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.issueIdsOrKeys).toHaveLength(100);
    expect(body.fields).toEqual(expect.arrayContaining(["summary", "status", "updated"]));
    expect(body.fields).not.toContain("comment");
  });
});

describe("retry and rate limits", () => {
  it("honours Retry-After on a 429, then succeeds", async () => {
    const { client, sleeps, fetchFn } = make([res(429, {}, { "Retry-After": "7", "RateLimit-Reason": "jira-burst-based" }), res(200, { ok: 1 })]);
    await expect(client.request("GET", "/myself")).resolves.toEqual({ ok: 1 });
    expect(sleeps).toEqual([7000]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("uses capped exponential backoff with jitter when there is no Retry-After", async () => {
    const { client, sleeps } = make([res(503), res(503), res(503), res(200, {})], { maxRetries: 4 });
    await client.request("GET", "/myself");
    expect(sleeps).toEqual([750, 1500, 3000]); // base 1 s, jitter 0.5 => 0.75x, doubling
  });

  it("throws JiraRateLimitError (for the queue) when the wait is long or retries are used up", async () => {
    const long = make([res(429, {}, { "Retry-After": "600" })]);
    await expect(long.client.request("GET", "/myself")).rejects.toMatchObject({ name: "JiraRateLimitError", retryAfterMs: 600_000 });
    expect(long.sleeps).toEqual([]); // it did not hold a worker for ten minutes
    const spent = make([res(429, {}, { "Retry-After": "1" })], { maxRetries: 2 });
    await expect(spent.client.request("GET", "/myself")).rejects.toBeInstanceOf(JiraRateLimitError);
    expect(spent.fetchFn).toHaveBeenCalledTimes(3);
  });

  it("opens a GLOBAL brake when the app-wide quota is used up, and fails fast afterwards", async () => {
    const a = make([res(429, {}, { "Retry-After": "120", "RateLimit-Reason": "jira-quota-global-based" })]);
    await expect(a.client.request("GET", "/myself")).rejects.toMatchObject({ global: true, reason: "jira-quota-global-based" });
    expect(globalBrakeRemaining(NOW)).toBe(120_000);
    // a different connection is also held back, without a single request
    const b = make([res(200, {})]);
    await expect(b.client.request("GET", "/myself")).rejects.toMatchObject({ name: "JiraRateLimitError", global: true });
    expect(b.fetchFn).not.toHaveBeenCalled();
  });

  it("the brake can be released", () => {
    engageGlobalBrake(5000, NOW);
    expect(globalBrakeRemaining(NOW)).toBe(5000);
    expect(globalBrakeRemaining(NOW + 6000)).toBe(0);
    resetGlobalBrake();
    expect(globalBrakeRemaining(NOW)).toBe(0);
  });

  it("logs the rate-limit headers", async () => {
    const seen: unknown[] = [];
    const { client } = make([res(200, {}, { "X-RateLimit-Remaining": "42", "X-RateLimit-Limit": "100", "RateLimit-Reason": "jira-quota-tenant-based" })], {
      onRateLimit: (s) => seen.push(s),
    });
    await client.request("GET", "/myself");
    expect(seen).toEqual([expect.objectContaining({ remaining: 42, limit: 100, reason: "jira-quota-tenant-based", status: 200 })]);
  });

  it("retries a network failure a few times, then reports it", async () => {
    const { client, fetchFn } = make([new TypeError("fetch failed")], { maxRetries: 2 });
    await expect(client.request("GET", "/myself")).rejects.toBeInstanceOf(JiraNetworkError);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("gives up on 5xx after the retries", async () => {
    const { client } = make([res(500)], { maxRetries: 1 });
    await expect(client.request("GET", "/myself")).rejects.toBeInstanceOf(JiraServerError);
  });

  it("parses Retry-After as seconds or a date, and backoff is capped", () => {
    expect(parseRetryAfter("5", NOW)).toBe(5000);
    expect(parseRetryAfter(new Date(NOW + 9000).toUTCString(), NOW)).toBe(9000);
    expect(parseRetryAfter("garbage", NOW)).toBeNull();
    expect(parseRetryAfter(null, NOW)).toBeNull();
    expect(backoffMs(20, () => 1)).toBe(30_000);
    expect(backoffMs(0, () => 0)).toBe(500);
  });

  it("limits concurrency per connection", async () => {
    let active = 0;
    let peak = 0;
    const { client } = make(
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return res(200, {});
      },
      { connectionKey: "shared", concurrency: 3 },
    );
    await Promise.all(Array.from({ length: 12 }, () => client.request("GET", "/myself")));
    expect(peak).toBe(3);
  });
});

describe("errors", () => {
  it("refreshes the token once on a 401 and retries with the new one", async () => {
    const { client, calls, tokens } = make([res(401), res(200, { accountId: "a" })]);
    await expect(client.getMyself()).resolves.toEqual({ accountId: "a" });
    expect(tokens).toEqual([undefined, "token-1"]);
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe("Bearer token-2");
  });

  it("a second 401 is an auth error, and tells the connection it is dead (reconnect)", async () => {
    let dead = 0;
    const { client } = make([res(401)], { onAuthFailure: () => void (dead += 1) });
    await expect(client.getMyself()).rejects.toBeInstanceOf(JiraAuthError);
    expect(dead).toBe(1);
  });

  it("maps 403, 404 and 410", async () => {
    await expect(make([res(403)]).client.getMyself()).rejects.toBeInstanceOf(JiraPermissionError);
    await expect(make([res(404)]).client.getIssue("ENG-9")).rejects.toBeInstanceOf(JiraNotFoundError);
    await expect(make([res(410)]).client.getIssue("ENG-9")).rejects.toBeInstanceOf(JiraNotFoundError);
    await expect(make([res(404)]).client.request("GET", "/myself", { allow404: true })).resolves.toBeNull();
  });

  it("carries Jira's field messages on a 400", async () => {
    const { client } = make([res(400, { errorMessages: ["Bad request"], errors: { summary: "Summary is required", customfield_10010: "Pick a value" } })]);
    const err = (await client.createIssue({}).catch((e) => e)) as JiraValidationError;
    expect(err).toBeInstanceOf(JiraValidationError);
    expect(err.messages).toEqual(["Bad request"]);
    expect(err.fieldErrors).toEqual({ summary: "Summary is required", customfield_10010: "Pick a value" });
  });

  it("returns null for 204 and parses the body otherwise", async () => {
    await expect(make([res(204)]).client.doTransition("ENG-1", "31")).resolves.toBeNull();
    await expect(make([res(201, { id: "1", key: "ENG-2" })]).client.createIssue({ summary: "x" })).resolves.toEqual({ id: "1", key: "ENG-2" });
  });

  it("never puts a token in an error message", async () => {
    const { client } = make([res(500, { detail: "Bearer token-1 leaked?" })], { maxRetries: 0 });
    const e = (await client.getMyself().catch((x) => x)) as Error;
    expect(e.message).not.toContain("token-1");
  });
});

describe("the calls Vircle makes", () => {
  it("creates a remote link with a stable globalId", async () => {
    const { client, calls } = make([res(200, { id: 5 })]);
    await client.upsertRemoteLink("10001", { globalId: "vircle:a:ticket:t", url: "https://crm.example.com/tickets/t", title: "Vircle ticket VIR-1" });
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.globalId).toBe("vircle:a:ticket:t");
    expect(body.application).toMatchObject({ name: "Vircle" });
    expect(body.object.title).toBe("Vircle ticket VIR-1");
  });

  it("registers dynamic webhooks with a JQL filter and the five events", async () => {
    const { client, calls } = make([res(200, { webhookRegistrationResult: [{ createdWebhookId: 1000 }] })]);
    await client.registerWebhooks({ url: "https://crm.example.com/api/integrations/jira/webhook/tok", events: ["jira:issue_updated"], jqlFilter: "project in (ENG)" });
    expect(calls[0].url).toMatch(/\/rest\/api\/3\/webhook$/);
    expect(JSON.parse(calls[0].init.body as string).webhooks[0]).toMatchObject({ events: ["jira:issue_updated"], jqlFilter: "project in (ENG)" });
  });

  it("sends the personal-data report to the fixed Atlassian address", async () => {
    const { client, calls } = make([res(200, { accounts: [{ accountId: "a", status: "closed" }] })]);
    await expect(client.reportAccounts([{ accountId: "a", updatedAt: "2026-09-20T10:00:00Z" }])).resolves.toEqual([{ accountId: "a", status: "closed" }]);
    expect(calls[0].url).toBe("https://api.atlassian.com/app/report-accounts/");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ accounts: [{ accountId: "a", updatedAt: "2026-09-20T10:00:00Z" }] });
    const nothing = make([res(204)]);
    await expect(nothing.client.reportAccounts([{ accountId: "a", updatedAt: "x" }])).resolves.toEqual([]);
  });
});
