import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { ensureWebhooks, webhookProjects, webhookRenewalDue } from "./connection";
import { applyReportResults, CATCHUP_INTERVAL_MS, collectAccountIds, processJob, runCatchup, runCron, runDaily, runJobs, runWeekly, type CronContext, type CronDeps } from "./cron";
import { JiraAuthError, JiraPermissionError, JiraRateLimitError } from "./errors";
import { pickEmailMatch } from "./users";
import { connectionRow, fakeClient, issue, linkRow, MemoryStore, ticketRow } from "./test-fakes";
import { DEFAULT_JIRA_SETTINGS, type JiraConnectionRow } from "./types";

const NOW = Date.parse("2026-09-20T10:05:00Z");

/** A recording stand-in for the Supabase client: every chain resolves to the rows of its table. */
function fakeDb(tables: Record<string, unknown[]> = {}) {
  const ops: { table: string; op: string; args: unknown[] }[] = [];
  const db = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      for (const op of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "in", "not", "is", "order", "limit", "maybeSingle", "single"]) {
        chain[op] = (...args: unknown[]) => {
          ops.push({ table, op, args });
          return chain;
        };
      }
      chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: tables[table] ?? [], error: null });
      return chain;
    },
  };
  return { db: db as unknown as SupabaseClient, ops };
}

function deps(store: MemoryStore, client: ReturnType<typeof fakeClient>["client"], over: Partial<CronDeps> = {}, db: SupabaseClient = fakeDb().db): CronDeps {
  return {
    db,
    store,
    baseUrl: "https://crm.example.com",
    readWebhookToken: async () => "tok",
    contextFor: (connection: JiraConnectionRow): CronContext => ({
      store,
      client: client as never,
      connection,
      settings: { ...DEFAULT_JIRA_SETTINGS },
      appUrl: "https://crm.example.com",
      now: () => NOW,
    }),
    now: () => NOW,
    worker: "w1",
    ...over,
  };
}

describe("jobs: claim, run, retry, dead-letter", () => {
  it("runs a sync job and marks it done", async () => {
    const store = new MemoryStore();
    store.links.push(linkRow());
    const fake = fakeClient({ getIssue: async () => issue({ status: { id: "2", name: "In Progress", category: "indeterminate" } }) });
    await store.enqueue({ accountId: "acct-1", connectionId: "conn-1", kind: "sync_issue", payload: { issue_id: "10001", comments: false } });
    const r = await runJobs(deps(store, fake.client), NOW + 50_000);
    expect(r).toEqual({ claimed: 1, done: 1, retried: 0, dead: 0 });
    expect(store.tickets[0].status).toBe("in_progress");
  });

  it("retries a rate limit and dead-letters a permanent error (no retry storm)", async () => {
    const store = new MemoryStore();
    store.links.push(linkRow());
    await store.enqueue({ accountId: "acct-1", connectionId: "conn-1", kind: "sync_issue", payload: { issue_id: "10001" } });
    const limited = fakeClient({ getIssue: async () => { throw new JiraRateLimitError(30_000); } });
    const r1 = await runJobs(deps(store, limited.client), NOW + 50_000);
    expect(r1).toMatchObject({ retried: 1, dead: 0 });
    expect(store.events.some((e) => e.kind === "job_retry")).toBe(true);

    const store2 = new MemoryStore();
    store2.links.push(linkRow());
    store2.tickets[0].status = "resolved";
    await store2.enqueue({ accountId: "acct-1", connectionId: "conn-1", kind: "push_status", payload: { ticket_id: "t-1", status: "resolved" } });
    const boom = fakeClient({ getIssue: async () => { throw new JiraPermissionError(); } });
    store2.connections[0].settings = { direction: { status_to_jira: true } };
    const r2 = await runJobs(
      deps(store2, boom.client, { contextFor: (c) => ({ store: store2, client: boom.client as never, connection: c, settings: { ...DEFAULT_JIRA_SETTINGS, direction: { ...DEFAULT_JIRA_SETTINGS.direction, status_to_jira: true } }, appUrl: "", now: () => NOW }) }),
      NOW + 50_000,
    );
    // the permission error is reported on the link, the job itself completes: nothing is retried
    expect(r2).toMatchObject({ done: 1, retried: 0, dead: 0 });
    expect(store2.links[0].last_push).toMatchObject({ ok: false, reason: "permission" });
  });

  it("waits for a reconnect instead of failing jobs of a paused connection, and kills jobs of a deleted one", async () => {
    const store = new MemoryStore();
    store.connections[0].status = "reauth_required";
    await store.enqueue({ accountId: "acct-1", connectionId: "conn-1", kind: "sync_issue", payload: { issue_id: "10001" } });
    const r = await runJobs(deps(store, fakeClient().client), NOW + 50_000);
    expect(r).toMatchObject({ claimed: 1, retried: 1 });

    const orphan = new MemoryStore();
    await orphan.enqueue({ accountId: "acct-1", connectionId: "gone", kind: "sync_issue", payload: { issue_id: "1" } });
    expect(await runJobs(deps(orphan, fakeClient().client), NOW + 50_000)).toMatchObject({ dead: 1 });
  });

  it("an auth error retries later (the connection is being reconnected), not dead", async () => {
    const store = new MemoryStore();
    store.links.push(linkRow());
    await store.enqueue({ accountId: "acct-1", connectionId: "conn-1", kind: "sync_issue", payload: { issue_id: "10001" } });
    const fake = fakeClient({ getIssue: async () => { throw new JiraAuthError(); } });
    expect(await runJobs(deps(store, fake.client), NOW + 50_000)).toMatchObject({ retried: 1, dead: 0 });
  });

  it("processJob routes each kind to its handler and ignores malformed payloads", async () => {
    const store = new MemoryStore();
    store.links.push(linkRow());
    const fake = fakeClient({ getIssue: async () => issue() });
    const ctx = deps(store, fake.client).contextFor(store.connections[0]);
    await processJob(ctx, { kind: "sync_issue", payload: {} });
    await processJob(ctx, { kind: "push_status", payload: { ticket_id: 5 } });
    await processJob(ctx, { kind: "post_comment", payload: {} });
    await processJob(ctx, { kind: "edit_comment", payload: {} });
    expect(fake.calls).toEqual([]);
    await processJob(ctx, { kind: "sync_issue", payload: { issue_id: "10001", comments: false } });
    expect(fake.calls.map((c) => c.method)).toEqual(["getIssue"]);
  });
});

describe("catch-up poll", () => {
  it("does ONE search plus ONE bulk read for all linked issues and applies changes like a webhook would", async () => {
    const store = new MemoryStore();
    store.connections[0].last_catchup_at = new Date(NOW - 6 * 60_000).toISOString();
    store.links.push(linkRow({ id: "a", issue_id: "10001", ticket_id: "t-1" }), linkRow({ id: "b", issue_id: "10002", issue_key: "ENG-2", ticket_id: "t-2" }));
    store.tickets.push(ticketRow({ id: "t-2", ticket_number: 13 }));
    const fake = fakeClient({
      searchIssues: async () => ({ issues: [{ id: "10001" }] }),
      bulkFetch: async () => [issue({ id: "10001", status: { id: "2", name: "In Progress", category: "indeterminate" } })],
    });
    const r = await runCatchup(deps(store, fake.client), store.connections[0]);
    expect(r).toEqual({ ran: true, issues: 1 });
    expect(fake.calls.filter((c) => c.method === "searchIssues")).toHaveLength(1);
    expect(fake.calls.filter((c) => c.method === "bulkFetch")).toHaveLength(1);
    const search = fake.calls[0].args[0] as { jql: string; fields: string[] };
    expect(search.jql).toBe("id in (10001,10002) AND updated >= -8m"); // 6 min gap + 2 min overlap, relative time
    expect(search.fields).toEqual(["updated"]);
    expect(store.tickets[0].status).toBe("in_progress");
    expect(store.tickets[1].status).toBe("open");
    expect(store.connections[0].last_catchup_at).toBe(new Date(NOW).toISOString());
  });

  it("is spaced by five minutes, skipped without live links, and re-reads everything on the first run", async () => {
    const store = new MemoryStore();
    store.links.push(linkRow());
    store.connections[0].last_catchup_at = new Date(NOW - CATCHUP_INTERVAL_MS + 1000).toISOString();
    const fake = fakeClient();
    expect(await runCatchup(deps(store, fake.client), store.connections[0])).toEqual({ ran: false, issues: 0 });
    expect(fake.calls).toEqual([]);

    const none = new MemoryStore();
    expect(await runCatchup(deps(none, fake.client), none.connections[0])).toEqual({ ran: false, issues: 0 });

    const first = new MemoryStore();
    first.links.push(linkRow());
    const f2 = fakeClient();
    await runCatchup(deps(first, f2.client), first.connections[0]);
    expect((f2.calls[0].args[0] as { jql: string }).jql).toBe("id in (10001)"); // no time clause
  });

  it("chunks the search when there are many linked issues", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 230; i++) store.links.push(linkRow({ id: `l${i}`, issue_id: String(20000 + i), issue_key: `ENG-${i}` }));
    const fake = fakeClient();
    await runCatchup(deps(store, fake.client), store.connections[0]);
    const searches = fake.calls.filter((c) => c.method === "searchIssues");
    expect(searches.length).toBe(3);
    for (const s of searches) expect((s.args[0] as { jql: string }).jql.length).toBeLessThan(1700);
  });

  it("only paused or broken links (nothing 'ok') means no calls at all", async () => {
    const store = new MemoryStore();
    store.links.push(linkRow({ sync_state: "paused" }), linkRow({ id: "x", sync_state: "broken", issue_id: "2" }));
    const fake = fakeClient();
    expect(await runCatchup(deps(store, fake.client), store.connections[0])).toEqual({ ran: false, issues: 0 });
    expect(fake.calls).toEqual([]);
  });
});

describe("webhook registration and renewal", () => {
  const client = (script: { list?: unknown[]; created?: number[] } = {}) => {
    const calls: { m: string; a: unknown[] }[] = [];
    return {
      calls,
      client: {
        listWebhooks: async () => (calls.push({ m: "list", a: [] }), { values: script.list ?? [] }),
        deleteWebhooks: async (ids: number[]) => (calls.push({ m: "delete", a: [ids] }), null),
        registerWebhooks: async (a: unknown) => (calls.push({ m: "register", a: [a] }), { webhookRegistrationResult: (script.created ?? [1001]).map((id) => ({ createdWebhookId: id })) }),
        refreshWebhooks: async (ids: number[]) => (calls.push({ m: "refresh", a: [ids] }), { expirationDate: "2026-10-20T00:00:00.000Z" }),
      } as never,
    };
  };
  const run = (store: MemoryStore, c: ReturnType<typeof client>, baseUrl = "https://crm.example.com") =>
    ensureWebhooks({ db: fakeDb().db, store, client: c.client, connection: store.connections[0], baseUrl, webhookToken: "secret-token", now: () => NOW });

  it("registers a project-limited webhook for the projects that have linked issues, on https only", async () => {
    const store = new MemoryStore();
    store.links.push(linkRow({ project_key: "ENG" }), linkRow({ id: "b", issue_id: "2", project_key: "WEB" }));
    const c = client();
    const r = await run(store, c);
    expect(r).toMatchObject({ action: "registered", ids: [1001] });
    const reg = c.calls.find((x) => x.m === "register")!.a[0] as { url: string; jqlFilter: string; events: string[] };
    expect(reg.url).toBe("https://crm.example.com/api/integrations/jira/webhook/secret-token");
    expect(reg.jqlFilter).toBe("project in (ENG,WEB)");
    expect(reg.events).toEqual(["jira:issue_updated", "jira:issue_deleted", "comment_created", "comment_updated", "comment_deleted"]);
    expect(store.connections[0].webhook_ids).toEqual([1001]);
    expect(store.connections[0].webhook_expires_at).toBe(new Date(NOW + 30 * 86_400_000).toISOString());

    const http = await run(store, client(), "http://localhost:3000");
    expect(http.action).toBe("skipped");
  });

  it("registers nothing while nothing is linked, and removes a webhook that is no longer needed", async () => {
    const empty = new MemoryStore();
    const c1 = client();
    expect((await run(empty, c1)).action).toBe("none");
    expect(c1.calls).toEqual([]);

    const had = new MemoryStore();
    had.connections[0].webhook_ids = [7];
    const c2 = client({ list: [{ id: 7, jqlFilter: "project in (ENG)" }] });
    expect((await run(had, c2)).action).toBe("removed");
    expect(c2.calls.some((x) => x.m === "delete")).toBe(true);
    expect(had.connections[0].webhook_ids).toEqual([]);
  });

  it("renews a healthy webhook (extends its 30 days) and replaces one whose project set changed", async () => {
    const same = new MemoryStore();
    same.links.push(linkRow({ project_key: "ENG" }));
    same.connections[0].webhook_ids = [7];
    const c1 = client({ list: [{ id: 7, jqlFilter: "project in (ENG)" }] });
    expect(await run(same, c1)).toMatchObject({ action: "refreshed", ids: [7] });
    expect(c1.calls.map((x) => x.m)).toEqual(["list", "refresh"]);

    const changed = new MemoryStore();
    changed.links.push(linkRow({ project_key: "ENG" }), linkRow({ id: "b", issue_id: "2", project_key: "WEB" }));
    changed.connections[0].webhook_ids = [7];
    const c2 = client({ list: [{ id: 7, jqlFilter: "project in (ENG)" }], created: [8] });
    expect(await run(changed, c2)).toMatchObject({ action: "replaced", ids: [8] });
    expect(c2.calls.map((x) => x.m)).toEqual(["list", "delete", "register"]);
  });

  it("re-registers a webhook Jira no longer lists (expired or removed)", async () => {
    const store = new MemoryStore();
    store.links.push(linkRow({ project_key: "ENG" }));
    store.connections[0].webhook_ids = [7];
    const c = client({ list: [], created: [9] });
    expect(await run(store, c)).toMatchObject({ action: "registered", ids: [9] });
  });

  it("a refused registration is logged and never throws (the catch-up still works)", async () => {
    const store = new MemoryStore();
    store.links.push(linkRow({ project_key: "ENG" }));
    const c = { client: { listWebhooks: async () => ({ values: [] }), registerWebhooks: async () => ({ webhookRegistrationResult: [{ errors: ["not allowed"] }] }) } as never };
    expect(await run(store, c as never)).toMatchObject({ action: "failed" });
    expect(store.events.some((e) => e.kind === "webhook_register_failed")).toBe(true);
  });

  it("covers the allowed projects too, and knows when a renewal is due", async () => {
    const store = new MemoryStore();
    store.connections[0].settings = { projects: { allowed: ["OPS"] } };
    store.links.push(linkRow({ project_key: "ENG" }));
    expect(await webhookProjects(store, store.connections[0])).toEqual(["ENG", "OPS"]);
    expect(webhookRenewalDue({ webhook_checked_at: null, webhook_expires_at: null }, NOW)).toBe(true);
    expect(webhookRenewalDue({ webhook_checked_at: new Date(NOW - 3_600_000).toISOString(), webhook_expires_at: new Date(NOW + 29 * 86_400_000).toISOString() }, NOW)).toBe(false);
    expect(webhookRenewalDue({ webhook_checked_at: new Date(NOW - 25 * 3_600_000).toISOString(), webhook_expires_at: null }, NOW)).toBe(true);
    expect(webhookRenewalDue({ webhook_checked_at: new Date(NOW - 3_600_000).toISOString(), webhook_expires_at: new Date(NOW + 5 * 86_400_000).toISOString() }, NOW)).toBe(true);
  });
});

describe("daily and weekly steps", () => {
  it("daily: proves the token works, keeps the webhook alive, matches members by email", async () => {
    const store = new MemoryStore();
    store.links.push(linkRow({ project_key: "ENG" }));
    const calls: string[] = [];
    const client = {
      getMyself: async () => (calls.push("myself"), { accountId: "acct-bot", displayName: "Vircle Bot" }),
      listWebhooks: async () => ({ values: [] }),
      registerWebhooks: async () => (calls.push("register"), { webhookRegistrationResult: [{ createdWebhookId: 5 }] }),
      searchUsers: async () => [],
    };
    const { db } = fakeDb({ profiles: [] });
    const r = await runDaily(deps(store, client as never, {}, db), store.connections[0]);
    expect(r).toMatchObject({ ran: true, webhook: "registered" });
    expect(calls).toEqual(["myself", "register"]);
    expect(store.connections[0].jira_display_name).toBe("Vircle Bot");
    // not due again straight away
    expect((await runDaily(deps(store, client as never, {}, db), store.connections[0])).ran).toBe(false);
  });

  it("weekly report: gated by a setting, at most weekly, in batches of 90, and applies 'closed' / 'updated'", async () => {
    const store = new MemoryStore();
    const reports: unknown[][] = [];
    const client = { reportAccounts: async (b: unknown[]) => (reports.push(b), [{ accountId: "acct-1", status: "closed" }]) };
    const ids = Array.from({ length: 200 }, (_, i) => ({ jira_account_id: `acct-${i}` }));
    const { db, ops } = fakeDb({ jira_user_map: ids, ticket_jira_links: [], jira_comment_map: [] });

    store.connections[0].settings = { personal_data_report: false };
    expect(await runWeekly(deps(store, client as never, {}, db), store.connections[0])).toEqual({ ran: false, reported: 0 });

    store.connections[0].settings = {};
    const r = await runWeekly(deps(store, client as never, {}, db), store.connections[0]);
    expect(r.ran).toBe(true);
    expect(reports.map((b) => b.length)).toEqual([90, 90, 21]); // 200 map ids + the connecting user
    expect(reports[0][0]).toMatchObject({ accountId: "acct-bot", updatedAt: new Date(NOW).toISOString() });
    expect(ops.some((o) => o.table === "jira_user_map" && o.op === "delete")).toBe(true); // erased what Atlassian closed
    expect(store.connections[0].last_report_at).toBe(new Date(NOW).toISOString());
    // reported this week already
    expect((await runWeekly(deps(store, client as never, {}, db), store.connections[0])).ran).toBe(false);
  });

  it("collects only ids and never a name or an email for the report", async () => {
    const { db } = fakeDb({ jira_user_map: [{ jira_account_id: "a1" }], ticket_jira_links: [{ assignee_account_id: "a2" }], jira_comment_map: [{ jira_author_account_id: "a3" }] });
    const ids = await collectAccountIds(db, connectionRow());
    expect(ids.sort()).toEqual(["a1", "a2", "a3", "acct-bot"]);
  });

  it("'updated' clears cached names, 'closed' erases the person", async () => {
    const { db, ops } = fakeDb({ jira_comment_map: [{ ticket_comment_id: "n1" }] });
    const r = await applyReportResults(db, connectionRow(), [
      { accountId: "x", status: "closed" },
      { accountId: "y", status: "updated" },
      { accountId: "z", status: "ok" },
    ]);
    expect(r).toEqual({ erased: 1, refreshed: 1 });
    expect(ops.find((o) => o.table === "ticket_comments" && o.op === "update")!.args[0]).toEqual({ jira_author: "Former Jira user" });
    expect(ops.some((o) => o.table === "ticket_jira_links" && o.op === "update")).toBe(true);
  });
});

describe("runCron", () => {
  it("runs jobs, then catch-up and the daily step per connection; a failing step does not stop the run", async () => {
    const store = new MemoryStore();
    store.links.push(linkRow({ project_key: "ENG" }));
    const client = {
      getMyself: async () => {
        throw new JiraRateLimitError(10_000);
      },
      searchIssues: async () => ({ issues: [] }),
      bulkFetch: async () => [],
      listWebhooks: async () => ({ values: [] }),
      reportAccounts: async () => [],
    };
    const { db } = fakeDb({ profiles: [] });
    const report = await runCron(deps(store, client as never, {}, db));
    expect(report.jobs.claimed).toBe(0);
    expect(report.catchup).toMatchObject({ connections: 1, failed: 0 });
    expect(store.events.some((e) => e.kind === "daily_failed")).toBe(true);
  });

  it("skips connections that need reconnecting (only active ones are listed)", async () => {
    const store = new MemoryStore();
    store.connections[0].status = "reauth_required";
    store.links.push(linkRow());
    const fake = fakeClient();
    const report = await runCron(deps(store, fake.client));
    expect(report.catchup.connections).toBe(0);
    expect(fake.calls).toEqual([]);
  });
});

describe("matching members to Jira users by email", () => {
  const u = (over: Record<string, unknown>) => ({ accountId: "a", displayName: "N", ...over });
  it("matches only an exact, visible, active, human email", () => {
    expect(pickEmailMatch("Maya@X.test", [u({ accountId: "1", emailAddress: "maya@x.test" })])?.accountId).toBe("1");
    expect(pickEmailMatch("maya@x.test", [u({ accountId: "1" })])).toBeNull(); // Jira hides the email: no guessing
    expect(pickEmailMatch("maya@x.test", [u({ accountId: "1", emailAddress: "maya@x.test", active: false })])).toBeNull();
    expect(pickEmailMatch("maya@x.test", [u({ accountId: "1", emailAddress: "maya@x.test", accountType: "app" })])).toBeNull();
    expect(pickEmailMatch("maya@x.test", [u({ accountId: "1", emailAddress: "maya@x.test" }), u({ accountId: "2", emailAddress: "maya@x.test" })])).toBeNull(); // ambiguous
    expect(pickEmailMatch("", [u({ emailAddress: "" })])).toBeNull();
  });
});
