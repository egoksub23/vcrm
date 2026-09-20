import { beforeEach, describe, expect, it } from "vitest";

import { bulkProgress, MAX_BULK_TICKETS, processBulkItem, reviewBulkCreate, startBulkCreate, startBulkLink, __resetBulkCacheForTests } from "./bulk";
import { runJobs, type CronContext, type CronDeps } from "./cron";
import { JiraPermissionError, JiraRateLimitError } from "./errors";
import { LinkError } from "./links";
import { fakeClient, issue, linkRow, makeContext, MemoryStore, ticketRow } from "./test-fakes";
import { DEFAULT_JIRA_SETTINGS, type JiraConnectionRow } from "./types";

const CF = "com.atlassian.jira.plugin.system.customfieldtypes:";
const NOW = Date.parse("2026-09-20T10:05:00Z");

const SCREEN_OK = [{ fieldId: "labels", name: "Labels", required: false }];
const SCREEN_UNSUPPORTED = [{ fieldId: "fixVersions", name: "Fix versions", required: true, schema: { type: "array", items: "version", system: "fixVersions" } }];
const SCREEN_ASKS = [{ fieldId: "customfield_61", name: "Severity note", required: true, schema: { type: "string", custom: `${CF}textfield` } }];

function tickets(store: MemoryStore, n: number) {
  store.tickets = Array.from({ length: n }, (_, i) => ticketRow({ id: `t-${i + 1}`, ticket_number: i + 1, subject: `Ticket ${i + 1}` }));
}

function setup(n = 3, script: Parameters<typeof fakeClient>[0] = {}, settings = {}) {
  const store = new MemoryStore();
  tickets(store, n);
  let created = 0;
  const keys = new Map<string, string>();
  const createIssue =
    script.createIssue ??
    (async () => {
      created += 1;
      return { id: String(20000 + created), key: `ENG-${100 + created}` };
    });
  const fake = fakeClient({
    listCreateFields: async () => ({ fields: SCREEN_OK }),
    // Jira reads an issue by key (a pasted reference) or by the id of one just created.
    getIssue: async (idOrKey) => {
      const ref = String(idOrKey);
      if (/^[A-Z]+-\d+$/.test(ref)) return issue({ id: "10001", key: ref });
      return issue({ id: ref, key: keys.get(ref) ?? "ENG-1" });
    },
    ...script,
    createIssue: async (fields) => {
      const made = await createIssue(fields);
      if (made) keys.set(made.id, made.key);
      return made;
    },
  });
  const ctx = makeContext(store, fake.client, { projects: { allowed: ["ENG"], default_project: "ENG", default_issue_type: "Task" }, ...settings } as never);
  return { store, fake, ctx };
}

const choices = { projectKey: "ENG", issueTypeId: "10004", issueTypeName: "Bug" };

function cronDeps(store: MemoryStore, ctx: ReturnType<typeof makeContext>): CronDeps {
  return {
    db: {} as never,
    store,
    baseUrl: "",
    readWebhookToken: async () => null,
    contextFor: (connection: JiraConnectionRow): CronContext => ({ ...ctx, connection, client: ctx.client as never }),
    now: () => NOW,
    worker: "w1",
  };
}

beforeEach(() => __resetBulkCacheForTests());

describe("bulk create: the review step", () => {
  it("lists each ticket's proposed project, type and summary, and writes nothing", async () => {
    const { store, ctx, fake } = setup(3);
    store.tickets[1].subject = `${"x".repeat(300)}`;
    const p = await reviewBulkCreate(ctx, { ticketIds: ["t-1", "t-2", "t-3"], choices });
    expect(p.map((x) => [x.ticketId, x.ticketKey, x.projectKey, x.issueTypeName, x.canCreate])).toEqual([
      ["t-1", "VIR-1", "ENG", "Bug", true],
      ["t-2", "VIR-2", "ENG", "Bug", true],
      ["t-3", "VIR-3", "ENG", "Bug", true],
    ]);
    expect(p[0].summary).toBe("Ticket 1");
    expect(p[1].summary.length).toBe(255); // cut to Jira's limit
    expect(fake.calls.filter((c) => c.method === "createIssue")).toEqual([]);
    expect(store.bulkBatches).toEqual([]);
    expect(store.jobs).toEqual([]);
  });

  it("flags the tickets that cannot be created and says why", async () => {
    const unsupported = setup(1, { listCreateFields: async () => ({ fields: SCREEN_UNSUPPORTED }) });
    expect((await reviewBulkCreate(unsupported.ctx, { ticketIds: ["t-1"], choices }))[0]).toMatchObject({ canCreate: false, reason: "unsupported_fields", fields: ["Fix versions"] });

    const asks = setup(1, { listCreateFields: async () => ({ fields: SCREEN_ASKS }) });
    expect((await reviewBulkCreate(asks.ctx, { ticketIds: ["t-1"], choices }))[0]).toMatchObject({ canCreate: false, reason: "required_fields", fields: ["Severity note"] });

    const full = setup(2);
    for (let i = 0; i < 5; i++) full.store.links.push(linkRow({ id: `l${i}`, ticket_id: "t-1", issue_id: String(i), issue_key: `ENG-${i}` }));
    const r = await reviewBulkCreate(full.ctx, { ticketIds: ["t-1", "t-2"], choices });
    expect(r.map((x) => [x.canCreate, x.reason])).toEqual([[false, "link_limit"], [true, undefined]]);

    const missing = setup(1);
    expect((await reviewBulkCreate(missing.ctx, { ticketIds: ["nope"], choices }))[0]).toMatchObject({ canCreate: false, reason: "not_found" });
  });

  it("a required field a mapping fills is not a blocker", async () => {
    const s = setup(1, { listCreateFields: async () => ({ fields: SCREEN_ASKS }) });
    s.store.fieldDefs = [{ id: "fd", label: "Note", field_type: "text", options: [] }];
    s.store.tickets[0].custom_fields = { fd: "hello" };
    s.store.fieldMappings = [{ id: "m", account_id: "acct-1", connection_id: "conn-1", project_key: "ENG", ticket_field_id: "fd", jira_field_id: "customfield_61", jira_field_name: "Severity note", jira_kind: "text", direction: "to_jira", when_missing: "skip", default_value: null, config: null }];
    expect((await reviewBulkCreate(s.ctx, { ticketIds: ["t-1"], choices }))[0].canCreate).toBe(true);
  });
});

describe("bulk create: start, run, progress", () => {
  it("makes one batch, one item and one queued job per ticket (max 25)", async () => {
    const { store, ctx } = setup(3);
    const r = await startBulkCreate(ctx, { items: ["t-1", "t-2", "t-3"].map((ticketId) => ({ ticketId, ...choices })), userId: "user-agent" });
    expect(r.total).toBe(3);
    expect(store.bulkBatches[0]).toMatchObject({ id: r.batchId, kind: "create", total: 3, created_by: "user-agent" });
    expect(store.bulkItems.map((i) => i.status)).toEqual(["pending", "pending", "pending"]);
    expect(store.jobs.map((j) => [j.kind, (j.payload as { item_id: string }).item_id])).toEqual(store.bulkItems.map((i) => ["bulk_item", i.id]));
    expect(store.jobs.every((j) => j.dedupe === null)).toBe(true); // never coalesced: one job per ticket
  });

  it("refuses more than 25, an empty selection, a project that is not allowed, and an inactive connection", async () => {
    const { store, ctx } = setup(30);
    const all = store.tickets.map((t) => ({ ticketId: t.id, ...choices }));
    await expect(startBulkCreate(ctx, { items: all, userId: null })).rejects.toMatchObject({ code: "bulk_limit" });
    expect(MAX_BULK_TICKETS).toBe(25);
    await expect(startBulkCreate(ctx, { items: [], userId: null })).rejects.toMatchObject({ code: "not_found" });
    await expect(startBulkCreate(ctx, { items: [{ ticketId: "t-1", ...choices, projectKey: "OPS" }], userId: null })).rejects.toMatchObject({ code: "project_not_allowed" });
    store.connections[0].status = "reauth_required";
    await expect(startBulkCreate(ctx, { items: [{ ticketId: "t-1", ...choices }], userId: null })).rejects.toMatchObject({ code: "inactive" });
    expect(store.bulkBatches).toEqual([]);
    expect(store.jobs).toEqual([]);
  });

  it("a repeated ticket in the selection counts once", async () => {
    const { store, ctx } = setup(2);
    const r = await startBulkCreate(ctx, { items: [{ ticketId: "t-1", ...choices }, { ticketId: "t-1", ...choices }, { ticketId: "t-2", ...choices }], userId: null });
    expect(r.total).toBe(2);
    expect(store.bulkItems).toHaveLength(2);
  });

  it("the queue fans out: every ticket gets its own issue, a link, and a logged result", async () => {
    const { store, ctx, fake } = setup(3);
    const r = await startBulkCreate(ctx, { items: ["t-1", "t-2", "t-3"].map((ticketId) => ({ ticketId, ...choices })), userId: "user-agent" });
    const before = await bulkProgress(ctx, r.batchId);
    expect(before).toMatchObject({ total: 3, finished: false, counts: { pending: 3, running: 0, done: 0, failed: 0, skipped: 0 } });

    const run = await runJobs(cronDeps(store, ctx), NOW + 50_000);
    expect(run).toEqual({ claimed: 3, done: 3, retried: 0, dead: 0 });
    expect(fake.calls.filter((c) => c.method === "createIssue")).toHaveLength(3);
    expect(store.links.map((l) => l.issue_key).sort()).toEqual(["ENG-101", "ENG-102", "ENG-103"]);
    const after = await bulkProgress(ctx, r.batchId);
    expect(after).toMatchObject({ finished: true, counts: { done: 3 } });
    expect(after!.items.map((i) => i.issue_key).sort()).toEqual(["ENG-101", "ENG-102", "ENG-103"]);
    expect(store.events.filter((e) => e.kind === "bulk_item_done")).toHaveLength(3);
    expect(store.audits.filter((a) => a.action === "linked")).toHaveLength(3); // the same audit trail as one-by-one
  });

  it("partial failure: the failures are recorded per ticket with a code, the rest go through", async () => {
    let n = 0;
    const { store, ctx } = setup(4, {
      createIssue: async () => {
        n += 1;
        if (n === 2) throw new JiraPermissionError();
        return { id: String(30000 + n), key: `ENG-${200 + n}` };
      },
    });
    for (let i = 0; i < 5; i++) store.links.push(linkRow({ id: `full${i}`, ticket_id: "t-3", issue_id: String(900 + i), issue_key: `ENG-${900 + i}` })); // t-3 is at the link limit
    const r = await startBulkCreate(ctx, { items: ["t-1", "t-2", "t-3", "t-4"].map((ticketId) => ({ ticketId, ...choices })), userId: "user-agent" });
    const run = await runJobs(cronDeps(store, ctx), NOW + 50_000);
    expect(run).toMatchObject({ claimed: 4, done: 4, dead: 0, retried: 0 }); // failed tickets settle; they are not retried
    const p = await bulkProgress(ctx, r.batchId);
    expect(p).toMatchObject({ finished: true, counts: { done: 2, failed: 2 } });
    const by = Object.fromEntries(p!.items.map((i) => [i.ticket_id, [i.status, i.code]]));
    expect(by["t-1"]).toEqual(["done", null]);
    expect(by["t-2"]).toEqual(["failed", "no_permission"]);
    expect(by["t-3"]).toEqual(["failed", "link_limit"]); // max 5 links per ticket is still enforced
    expect(by["t-4"]).toEqual(["done", null]);
    expect(store.events.filter((e) => e.kind === "bulk_item_failed")).toHaveLength(2);
    expect(store.links.filter((l) => l.ticket_id === "t-3")).toHaveLength(5);
  });

  it("a rate limit puts the item back in the queue (pending) so it backs off; nothing is lost or duplicated", async () => {
    let limited = true;
    const { store, ctx, fake } = setup(1, {
      createIssue: async () => {
        if (limited) throw new JiraRateLimitError(20_000);
        return { id: "30001", key: "ENG-301" };
      },
    });
    const r = await startBulkCreate(ctx, { items: [{ ticketId: "t-1", ...choices }], userId: null });
    const first = await runJobs(cronDeps(store, ctx), NOW + 50_000);
    expect(first).toMatchObject({ claimed: 1, retried: 1, done: 0 });
    expect(store.bulkItems[0].status).toBe("pending");
    expect((await bulkProgress(ctx, r.batchId))!.finished).toBe(false);
    limited = false;
    store.jobs.forEach((j) => (j.status = "pending")); // the backoff elapsed
    await runJobs(cronDeps(store, ctx), NOW + 50_000);
    expect(store.bulkItems[0]).toMatchObject({ status: "done", issue_key: "ENG-301" });
    expect(fake.calls.filter((c) => c.method === "createIssue")).toHaveLength(2); // the limited attempt and the good one
    expect(store.links).toHaveLength(1);
  });

  it("running a finished item again does nothing (a retry after a crash never creates a second issue)", async () => {
    const { store, ctx, fake } = setup(1);
    await startBulkCreate(ctx, { items: [{ ticketId: "t-1", ...choices }], userId: null });
    const item = store.bulkItems[0];
    const args = { batchId: item.batch_id, itemId: item.id, userId: null };
    expect(await processBulkItem(ctx, args)).toBe("done");
    expect(await processBulkItem(ctx, args)).toBe("done");
    expect(fake.calls.filter((c) => c.method === "createIssue")).toHaveLength(1);
    expect(await processBulkItem(ctx, { ...args, itemId: "missing" })).toBe("gone");
  });

  it("the include-customer privacy option is honoured per ticket", async () => {
    const seen: Record<string, unknown>[] = [];
    const { store, ctx } = setup(1, { createIssue: async (f) => (seen.push(f), { id: "1", key: "ENG-1" }) }, { privacy: { include_customer: true, preview_before_send: true } });
    await startBulkCreate(ctx, { items: [{ ticketId: "t-1", ...choices }], userId: null });
    await processBulkItem(ctx, { batchId: store.bulkBatches[0].id, itemId: store.bulkItems[0].id, userId: null });
    expect(JSON.stringify(seen[0].description)).toContain("casey@example.com");
  });
});

describe("bulk link: many tickets, ONE issue", () => {
  it("reads the issue once, then links every ticket to it", async () => {
    const { store, ctx, fake } = setup(3);
    const r = await startBulkLink(ctx, { ticketIds: ["t-1", "t-2", "t-3"], reference: "https://acme.atlassian.net/browse/ENG-1", userId: "user-agent" });
    expect(r).toMatchObject({ total: 3, issueKey: "ENG-1" });
    expect(store.bulkBatches[0]).toMatchObject({ kind: "link", target_issue_id: "10001", target_issue_key: "ENG-1" });
    await runJobs(cronDeps(store, ctx), NOW + 50_000);
    expect(store.links.map((l) => [l.ticket_id, l.issue_key]).sort()).toEqual([["t-1", "ENG-1"], ["t-2", "ENG-1"], ["t-3", "ENG-1"]]);
    // one read at the start; the items reuse it (Jira's quota is shared by every customer)
    expect(fake.calls.filter((c) => c.method === "getIssue")).toHaveLength(1);
    expect(await bulkProgress(ctx, r.batchId)).toMatchObject({ finished: true, counts: { done: 3 }, targetIssueKey: "ENG-1" });
  });

  it("an already linked ticket is skipped (not a failure); a ticket at five links fails with link_limit", async () => {
    const { store, ctx } = setup(3);
    store.links.push(linkRow({ id: "same", ticket_id: "t-1", issue_id: "10001", issue_key: "ENG-1" }));
    for (let i = 0; i < 5; i++) store.links.push(linkRow({ id: `f${i}`, ticket_id: "t-2", issue_id: String(500 + i), issue_key: `ENG-${500 + i}` }));
    const r = await startBulkLink(ctx, { ticketIds: ["t-1", "t-2", "t-3"], reference: "ENG-1", userId: null });
    await runJobs(cronDeps(store, ctx), NOW + 50_000);
    const p = await bulkProgress(ctx, r.batchId);
    expect(p).toMatchObject({ counts: { skipped: 1, failed: 1, done: 1 } });
    const by = Object.fromEntries(p!.items.map((i) => [i.ticket_id, [i.status, i.code]]));
    expect(by).toEqual({ "t-1": ["skipped", "already_linked"], "t-2": ["failed", "link_limit"], "t-3": ["done", null] });
  });

  it("refuses a bad reference, a missing issue, an issue in a project that is not allowed, and more than 25", async () => {
    const { ctx, store } = setup(30, { getIssue: async () => null });
    await expect(startBulkLink(ctx, { ticketIds: ["t-1"], reference: "not an issue", userId: null })).rejects.toMatchObject({ code: "bad_reference" });
    await expect(startBulkLink(ctx, { ticketIds: ["t-1"], reference: "ENG-9", userId: null })).rejects.toMatchObject({ code: "not_found" });
    await expect(startBulkLink(ctx, { ticketIds: store.tickets.map((t) => t.id), reference: "ENG-1", userId: null })).rejects.toBeInstanceOf(LinkError);
    const other = setup(1, { getIssue: async () => ({ ...issue({ key: "OPS-1" }), fields: { ...issue().fields, project: { id: "9", key: "OPS", name: "Ops" } } }) });
    await expect(startBulkLink(other.ctx, { ticketIds: ["t-1"], reference: "OPS-1", userId: null })).rejects.toMatchObject({ code: "project_not_allowed" });
    expect(other.store.bulkBatches).toEqual([]);
  });
});

describe("progress", () => {
  it("is scoped to the workspace that started it", async () => {
    const { store, ctx } = setup(1);
    const r = await startBulkCreate(ctx, { items: [{ ticketId: "t-1", ...choices }], userId: null });
    expect(await bulkProgress(ctx, r.batchId)).not.toBeNull();
    expect(await bulkProgress({ store, connection: { ...ctx.connection, account_id: "other" } }, r.batchId)).toBeNull();
    expect(await bulkProgress(ctx, "nope")).toBeNull();
    expect(DEFAULT_JIRA_SETTINGS.projects.allowed).toEqual([]);
  });
});
