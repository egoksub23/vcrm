import { beforeEach, describe, expect, it } from "vitest";

import { textToAdf } from "./adf";
import { JiraNotFoundError, JiraPermissionError, JiraRateLimitError } from "./errors";
import { hashText } from "./rules";
import { editSharedNote, pushStatus, resyncLink, resyncWaitMs, shareNoteToJira, syncIssue } from "./sync";
import { fakeClient, issue, linkRow, makeContext, MemoryStore } from "./test-fakes";
import { VIRCLE_COMMENT_PROPERTY } from "./types";

const adf = (text: string) => textToAdf(text);

function setup(script: Parameters<typeof fakeClient>[0] = {}, settings: Parameters<typeof makeContext>[2] = {}) {
  const store = new MemoryStore();
  store.links.push(linkRow({ issue_id: "10001", issue_key: "ENG-1" }));
  const fake = fakeClient(script);
  const ctx = makeContext(store, fake.client, settings);
  return { store, ctx, fake };
}

const inProgress = { id: "2", name: "In Progress", category: "indeterminate" };
const done = { id: "3", name: "Done", category: "done" };

describe("syncIssue: Jira to Vircle", () => {
  it("re-reads the issue, updates the card cache and applies the changed status to the ticket", async () => {
    const { store, ctx, fake } = setup({ getIssue: async () => issue({ status: inProgress, updated: "2026-09-20T10:04:00.000+0000" }) });
    const r = await syncIssue(ctx, "10001", { comments: false });
    expect(r.statusApplied).toEqual([{ ticketId: "t-1", status: "in_progress" }]);
    expect(store.tickets[0].status).toBe("in_progress");
    expect(store.links[0]).toMatchObject({ status_name: "In Progress", status_category: "indeterminate", sync_state: "ok", sync_error: null });
    expect(store.links[0].last_synced_at).toBe("2026-09-20T10:05:00.000Z");
    // only the issue was read (one GET, no comment listing)
    expect(fake.calls.map((c) => c.method)).toEqual(["getIssue"]);
  });

  it("is idempotent: syncing the same state twice changes nothing the second time", async () => {
    const { store, ctx } = setup({ getIssue: async () => issue({ status: inProgress }) });
    await syncIssue(ctx, "10001", { comments: false });
    const again = await syncIssue(ctx, "10001", { comments: false });
    expect(again.statusApplied).toEqual([]);
    expect(store.appliedStatuses).toHaveLength(1);
  });

  it("drops an older event (the fetched issue is older than what is already applied)", async () => {
    const { store, ctx } = setup({ getIssue: async () => issue({ status: inProgress, updated: "2026-09-20T08:00:00.000+0000" }) });
    const r = await syncIssue(ctx, "10001", { comments: false });
    expect(r.droppedOlder).toBe(1);
    expect(store.tickets[0].status).toBe("open");
    expect(store.events.some((e) => e.kind === "dropped_older")).toBe(true);
  });

  it("a status that came FROM Jira never queues an outbound push (no loop)", async () => {
    const { store, ctx } = setup({ getIssue: async () => issue({ status: inProgress }) }, { direction: { status_to_jira: true } as never });
    await syncIssue(ctx, "10001", { comments: false });
    expect(store.appliedStatuses).toHaveLength(1);
    expect(store.jobs).toEqual([]); // the SQL trigger skips vircle.source = 'jira'; the worker enqueues nothing itself
  });

  it("Done: notifies the ticket owner and adds an internal note instead of resolving", async () => {
    const { store, ctx } = setup({ getIssue: async () => issue({ status: done }) });
    await syncIssue(ctx, "10001", { comments: false });
    expect(store.tickets[0].status).toBe("open");
    expect(store.notifications).toEqual([{ type: "jira_issue_done", ticketId: "t-1", body: "ENG-1 is Done in Jira: Login fails on Safari" }]);
    expect(store.notes.map((n) => [n.source, n.body, n.jira_author])).toEqual([["jira", "ENG-1 is Done in Jira.", "Jira"]]);
  });

  it("Done with the opt-in resolves the ticket", async () => {
    const { store, ctx } = setup({ getIssue: async () => issue({ status: done }) }, { done_behaviour: "resolve" });
    await syncIssue(ctx, "10001", { comments: false });
    expect(store.tickets[0].status).toBe("resolved");
    expect(store.notifications).toEqual([]);
  });

  it("uses an admin's per-status override over the category", async () => {
    const { store, ctx } = setup(
      { getIssue: async () => issue({ status: { id: "5", name: "Waiting for customer", category: "indeterminate" } }) },
      { mapping: { status_from_jira: { "waiting for customer": "pending" }, status_to_jira: {}, priority: {}, category_label: true } },
    );
    await syncIssue(ctx, "10001", { comments: false });
    expect(store.tickets[0].status).toBe("pending");
  });

  it("assignee: only with the toggle AND a user map; unmatched people are skipped", async () => {
    const assignee = { accountId: "acct-priya", displayName: "Priya" };
    const off = setup({ getIssue: async () => issue({ assignee }) });
    off.store.userMap.push({ id: "u", account_id: "acct-1", user_id: "user-priya", jira_account_id: "acct-priya", jira_display_name: "Priya", method: "manual" });
    await syncIssue(off.ctx, "10001", { comments: false });
    expect(off.store.assigneeChanges).toEqual([]); // toggle off

    const on = setup({ getIssue: async () => issue({ assignee }) }, { direction: { assignee: true } as never });
    on.store.userMap.push({ id: "u", account_id: "acct-1", user_id: "user-priya", jira_account_id: "acct-priya", jira_display_name: "Priya", method: "manual" });
    await syncIssue(on.ctx, "10001", { comments: false });
    expect(on.store.assigneeChanges).toEqual([{ ticketId: "t-1", userId: "user-priya" }]);
    expect(on.store.links[0].assignee_name).toBe("Priya"); // the card shows the Jira assignee either way

    const unmapped = setup({ getIssue: async () => issue({ assignee }) }, { direction: { assignee: true } as never });
    await syncIssue(unmapped.ctx, "10001", { comments: false });
    expect(unmapped.store.assigneeChanges).toEqual([]);
    expect(unmapped.store.links[0].assignee_name).toBe("Priya");
  });

  it("follows a moved issue by its permanent id: key and project update on the card", async () => {
    const { store, ctx } = setup({ getIssue: async () => issue({ id: "10001", key: "WEB-7" }) });
    await syncIssue(ctx, "10001", { comments: false });
    expect(store.links[0].issue_key).toBe("WEB-7");
    expect(store.links[0].issue_url).toBe("https://acme.atlassian.net/browse/WEB-7");
    expect(store.events.some((e) => e.kind === "issue_moved")).toBe(true);
  });

  it("a deleted or invisible issue makes the link 'broken', keeps the last known data, and does not throw", async () => {
    const { store, ctx } = setup({
      getIssue: async () => {
        throw new JiraNotFoundError();
      },
    });
    const r = await syncIssue(ctx, "10001");
    expect(r.broken).toBe("not_found");
    expect(store.links[0]).toMatchObject({ sync_state: "broken", sync_error: "not_found", summary: "Login fails", status_name: "To Do" });
  });

  it("a 403 marks the link with a clear reason and is NOT retried (no retry storm)", async () => {
    const { store, ctx } = setup({
      getIssue: async () => {
        throw new JiraPermissionError();
      },
    });
    await expect(syncIssue(ctx, "10001")).resolves.toMatchObject({ broken: "no_access" });
    expect(store.links[0].sync_error).toBe("no_access");
  });

  it("rate limits and outages propagate so the queue can back off", async () => {
    const { ctx } = setup({
      getIssue: async () => {
        throw new JiraRateLimitError(30_000);
      },
    });
    await expect(syncIssue(ctx, "10001")).rejects.toBeInstanceOf(JiraRateLimitError);
  });

  it("a broken link recovers when the issue is readable again", async () => {
    const { store, ctx } = setup({ getIssue: async () => issue() });
    store.links[0].sync_state = "broken";
    store.links[0].sync_error = "not_found";
    await syncIssue(ctx, "10001", { comments: false });
    expect(store.links[0]).toMatchObject({ sync_state: "ok", sync_error: null });
  });

  it("does nothing for paused links and inactive connections", async () => {
    const { store, ctx, fake } = setup({ getIssue: async () => issue() });
    store.links[0].sync_state = "paused";
    expect(await syncIssue(ctx, "10001")).toMatchObject({ skipped: "no_links" });
    store.links[0].sync_state = "ok";
    ctx.connection.status = "reauth_required";
    expect(await syncIssue(ctx, "10001")).toMatchObject({ skipped: "connection_inactive" });
    expect(fake.calls).toEqual([]);
  });
});

describe("comments from Jira", () => {
  const comment = (over: Record<string, unknown> = {}) => ({
    id: "5001",
    body: adf("Looking into it now"),
    author: { accountId: "acct-priya", displayName: "Priya (Engineering)" },
    updated: "2026-09-20T10:01:00.000+0000",
    ...over,
  });

  it("a new Jira comment becomes an internal note tagged with the Jira author, and never queues anything to Jira", async () => {
    const { store, ctx } = setup({ getIssue: async () => issue(), listComments: async () => ({ comments: [comment()], total: 1 }) });
    await syncIssue(ctx, "10001");
    expect(store.notes).toHaveLength(1);
    expect(store.notes[0]).toMatchObject({ source: "jira", author_id: null, jira_author: "Priya (Engineering)", jira_comment_id: "5001", body: "Looking into it now" });
    expect(store.maps).toHaveLength(1);
    expect(store.maps[0]).toMatchObject({ origin: "jira", jira_comment_id: "5001", ticket_comment_id: store.notes[0].id });
    expect(store.jobs).toEqual([]);
  });

  it("the second sync does not duplicate the note (map + hash)", async () => {
    const { store, ctx } = setup({ getIssue: async () => issue(), listComments: async () => ({ comments: [comment()], total: 1 }) });
    await syncIssue(ctx, "10001");
    await syncIssue(ctx, "10001");
    expect(store.notes).toHaveLength(1);
  });

  it("an edit in Jira updates the note; a deletion marks it 'deleted in Jira' and keeps the text", async () => {
    let comments = [comment()];
    const { store, ctx } = setup({ getIssue: async () => issue(), listComments: async () => ({ comments, total: comments.length }) });
    await syncIssue(ctx, "10001");
    comments = [comment({ body: adf("Root cause found"), updated: "2026-09-20T10:03:00.000+0000" })];
    await syncIssue(ctx, "10001");
    expect(store.notes[0].body).toBe("Root cause found");
    comments = [];
    await syncIssue(ctx, "10001");
    expect(store.notes[0]).toMatchObject({ body: "Root cause found", deleted_in_jira: true });
    expect(store.maps[0].deleted_in_jira).toBe(true);
  });

  it("existing comments at link time are seen, not imported", async () => {
    const { store, ctx } = setup({ getIssue: async () => issue(), listComments: async () => ({ comments: [comment(), comment({ id: "5002" })], total: 2 }) });
    await syncIssue(ctx, "10001", { seedComments: true });
    expect(store.notes).toEqual([]);
    expect(store.maps.map((m) => m.jira_comment_id).sort()).toEqual(["5001", "5002"]);
    // and a NEW comment afterwards does come in
    const later = setup({ getIssue: async () => issue(), listComments: async () => ({ comments: [comment(), comment({ id: "5003", body: adf("Fixed in 2.1") })], total: 2 }) });
    later.store.maps.push({ id: "m", account_id: "acct-1", link_id: later.store.links[0].id, ticket_comment_id: null, jira_comment_id: "5001", origin: "jira", jira_author_account_id: null, body_hash: hashText("Looking into it now"), jira_updated_at: null, deleted_in_jira: false });
    await syncIssue(later.ctx, "10001");
    expect(later.store.notes.map((n) => n.body)).toEqual(["Fixed in 2.1"]);
  });

  it("ECHO: a comment Vircle posted is ignored when it comes back through the webhook", async () => {
    const { store, ctx } = setup({
      getIssue: async () => issue(),
      addComment: async () => ({ id: "7001" }),
      listComments: async () => ({ comments: [comment({ id: "7001", body: adf("Maya (Vircle): please check") })], total: 1 }),
    });
    const note = store.addAgentNote("please check");
    const shared = await shareNoteToJira(ctx, { noteId: note.id, actorUserId: "user-agent" });
    expect(shared).toEqual([expect.objectContaining({ ok: true, code: "shared" })]);
    expect(store.maps[0]).toMatchObject({ origin: "vircle", jira_comment_id: "7001", ticket_comment_id: note.id });
    // the webhook for the same comment id arrives: nothing new appears
    await syncIssue(ctx, "10001");
    expect(store.notes).toHaveLength(1); // only the agent's own note
  });

  it("ECHO: our marker property protects even when the webhook is faster than the map row", async () => {
    const { store, ctx } = setup({
      getIssue: async () => issue(),
      listComments: async () => ({
        comments: [comment({ id: "7002", body: adf("Maya (Vircle): hi"), properties: [{ key: VIRCLE_COMMENT_PROPERTY, value: { v: 1 } }] })],
        total: 1,
      }),
    });
    await syncIssue(ctx, "10001");
    expect(store.notes).toEqual([]);
    expect(store.maps[0]).toMatchObject({ origin: "vircle", ticket_comment_id: null });
  });

  it("a restricted comment is never copied and comments_from_jira off skips all", async () => {
    const restricted = setup({ getIssue: async () => issue(), listComments: async () => ({ comments: [comment({ visibility: { type: "role", value: "Administrators" } })], total: 1 }) });
    await syncIssue(restricted.ctx, "10001");
    expect(restricted.store.notes).toEqual([]);
    const off = setup({ getIssue: async () => issue(), listComments: async () => ({ comments: [comment()], total: 1 }) }, { direction: { comments_from_jira: false } as never });
    await syncIssue(off.ctx, "10001");
    expect(off.store.notes).toEqual([]);
  });

  it("two workers importing the same comment create ONE note (the map claim is unique)", async () => {
    const { store, ctx } = setup({ getIssue: async () => issue(), listComments: async () => ({ comments: [comment()], total: 1 }) });
    await Promise.all([syncIssue(ctx, "10001"), syncIssue(ctx, "10001")]);
    expect(store.notes).toHaveLength(1);
  });
});

describe("Share with Jira (Vircle to Jira comments)", () => {
  it("posts as 'Name (Vircle): text', with the marker property, and records the id immediately", async () => {
    const { store, ctx, fake } = setup({ addComment: async () => ({ id: "8001", author: { accountId: "acct-bot" } }) });
    const note = store.addAgentNote("The customer is blocked");
    await shareNoteToJira(ctx, { noteId: note.id, actorUserId: "user-agent" });
    const call = fake.calls.find((c) => c.method === "addComment")!;
    expect(call.args[0]).toBe("10001");
    expect(JSON.stringify(call.args[1])).toContain("Maya (Vircle):");
    expect(JSON.stringify(call.args[1])).toContain("The customer is blocked");
    expect(call.args[2]).toEqual([{ key: VIRCLE_COMMENT_PROPERTY, value: { v: 1, note: note.id } }]);
    expect(store.maps[0]).toMatchObject({ origin: "vircle", jira_comment_id: "8001", body_hash: hashText("The customer is blocked") });
  });

  it("never sends a note that came from Jira back to Jira", async () => {
    const { store, ctx, fake } = setup();
    const fromJira = store.addAgentNote("engineering says hi", { source: "jira", author_id: null });
    expect(await shareNoteToJira(ctx, { noteId: fromJira.id, actorUserId: "user-agent" })).toEqual([expect.objectContaining({ ok: false, code: "not_shareable" })]);
    expect(fake.calls.filter((c) => c.method === "addComment")).toEqual([]);
  });

  it("sharing twice is idempotent (already shared)", async () => {
    const { store, ctx, fake } = setup();
    const note = store.addAgentNote("once");
    await shareNoteToJira(ctx, { noteId: note.id, actorUserId: "user-agent" });
    const again = await shareNoteToJira(ctx, { noteId: note.id, actorUserId: "user-agent" });
    expect(again[0]).toMatchObject({ ok: true, code: "already" });
    expect(fake.calls.filter((c) => c.method === "addComment")).toHaveLength(1);
  });

  it("respects the comments_to_jira toggle and only posts to healthy links", async () => {
    const off = setup({}, { direction: { comments_to_jira: false } as never });
    const n1 = off.store.addAgentNote("x");
    expect(await shareNoteToJira(off.ctx, { noteId: n1.id, actorUserId: "user-agent" })).toEqual([expect.objectContaining({ code: "toggle_off" })]);
    const paused = setup();
    paused.store.links[0].sync_state = "paused";
    const n2 = paused.store.addAgentNote("x");
    expect(await shareNoteToJira(paused.ctx, { noteId: n2.id, actorUserId: "user-agent" })).toEqual([]);
  });

  it("a permission error is reported per link and not retried; a rate limit is thrown for the queue", async () => {
    const denied = setup({
      addComment: async () => {
        throw new JiraPermissionError();
      },
    });
    const note = denied.store.addAgentNote("x");
    expect(await shareNoteToJira(denied.ctx, { noteId: note.id, actorUserId: "user-agent" })).toEqual([expect.objectContaining({ ok: false, code: "permission" })]);

    const busy = setup({
      addComment: async () => {
        throw new JiraRateLimitError(20_000);
      },
    });
    const n = busy.store.addAgentNote("x");
    await expect(shareNoteToJira(busy.ctx, { noteId: n.id, actorUserId: "user-agent" })).rejects.toBeInstanceOf(JiraRateLimitError);
  });

  it("an edit in Vircle updates the Jira comment (PUT), a deletion in Vircle does not delete in Jira", async () => {
    const { store, ctx, fake } = setup({ addComment: async () => ({ id: "8002" }) });
    const note = store.addAgentNote("first version");
    await shareNoteToJira(ctx, { noteId: note.id, actorUserId: "user-agent" });
    note.body = "second version";
    expect(await editSharedNote(ctx, note.id)).toBe(1);
    const put = fake.calls.find((c) => c.method === "updateComment")!;
    expect(put.args.slice(0, 2)).toEqual(["10001", "8002"]);
    expect(JSON.stringify(put.args[2])).toContain("second version");
    expect(store.maps[0].body_hash).toBe(hashText("second version"));
    // nothing changed: no second PUT
    expect(await editSharedNote(ctx, note.id)).toBe(0);
    expect(fake.calls.filter((c) => c.method === "updateComment")).toHaveLength(1);
    // there is no client method that deletes a Jira comment at all
    expect(Object.keys(fake.client)).not.toContain("deleteComment");
  });
});

describe("pushStatus: Vircle to Jira", () => {
  const transitions = {
    transitions: [
      { id: "11", name: "Start", to: { id: "2", name: "In Progress", statusCategory: { key: "indeterminate" } }, isAvailable: true },
      { id: "31", name: "Finish", to: { id: "3", name: "Done", statusCategory: { key: "done" } }, isAvailable: true, hasScreen: true, fields: { resolution: { required: true, allowedValues: [{ name: "Done" }] } } },
    ],
  };
  const enabled = { direction: { status_to_jira: true } as never };

  it("picks the ONE transition that lands on the mapped status and remembers what it wrote", async () => {
    const { store, ctx, fake } = setup({ getIssue: async () => issue(), getTransitions: async () => transitions }, enabled);
    store.tickets[0].status = "in_progress";
    const r = await pushStatus(ctx, { ticketId: "t-1", status: "in_progress" });
    expect(r.links[0].result).toMatchObject({ ok: true, reason: "moved" });
    expect(fake.calls.filter((c) => c.method === "doTransition")).toHaveLength(1);
    expect(fake.calls.find((c) => c.method === "doTransition")!.args.slice(0, 2)).toEqual(["10001", "11"]);
    expect(store.links[0].last_written).toMatchObject({ status_category: "indeterminate", status_name: "In Progress" });
    expect(store.links[0]).toMatchObject({ status_name: "In Progress", status_category: "indeterminate" });
    expect(store.activity).toContainEqual(expect.objectContaining({ eventType: "jira_status_pushed", toValue: "In Progress", detail: "ENG-1" }));
  });

  it("supplies the resolution a Done transition demands", async () => {
    const { store, ctx, fake } = setup({ getIssue: async () => issue({ status: inProgress }), getTransitions: async () => transitions }, enabled);
    store.tickets[0].status = "resolved";
    await pushStatus(ctx, { ticketId: "t-1", status: "resolved" });
    expect(fake.calls.find((c) => c.method === "doTransition")!.args).toEqual(["10001", "31", { resolution: { name: "Done" } }]);
  });

  it("ECHO: the webhook for our own transition does not bounce back into the ticket", async () => {
    const { store, ctx } = setup({ getIssue: async () => issue(), getTransitions: async () => transitions }, enabled);
    store.tickets[0].status = "in_progress";
    await pushStatus(ctx, { ticketId: "t-1", status: "in_progress" });
    // Jira now reports In Progress; the ticket already is in_progress and the cache matches
    const after = setup({ getIssue: async () => issue({ status: inProgress, updated: "2026-09-20T10:05:30.000+0000" }) }, enabled);
    after.store.tickets[0].status = "in_progress";
    Object.assign(after.store.links[0], { status_id: "2", status_name: "In Progress", status_category: "indeterminate", last_written: store.links[0].last_written });
    const r = await syncIssue(after.ctx, "10001", { comments: false });
    expect(r.statusApplied).toEqual([]);
    expect(after.store.appliedStatuses).toEqual([]);
    expect(after.store.jobs).toEqual([]);
  });

  it("tells the agent when there is no transition, and leaves Jira alone", async () => {
    const { store, ctx, fake } = setup({ getIssue: async () => issue({ status: done }), getTransitions: async () => ({ transitions: [] }) }, enabled);
    store.tickets[0].status = "open";
    const r = await pushStatus(ctx, { ticketId: "t-1", status: "open" });
    expect(r.links[0].result).toMatchObject({ ok: false, reason: "no_transition" });
    expect(store.links[0].last_push).toMatchObject({ ok: false, reason: "no_transition" });
    expect(fake.calls.some((c) => c.method === "doTransition")).toBe(false);
    expect(store.events.some((e) => e.kind === "push_no_transition")).toBe(true);
  });

  it("never chains: a transition that needs a field it cannot fill is refused, nothing is sent", async () => {
    const { store, ctx, fake } = setup(
      {
        getIssue: async () => issue(),
        getTransitions: async () => ({ transitions: [{ id: "31", name: "Finish", to: { id: "3", name: "Done", statusCategory: { key: "done" } }, isAvailable: true, fields: { customfield_1: { required: true, name: "Root cause" } } }] }),
      },
      enabled,
    );
    store.tickets[0].status = "resolved";
    const r = await pushStatus(ctx, { ticketId: "t-1", status: "resolved" });
    expect(r.links[0].result).toMatchObject({ ok: false, reason: "screen_fields" });
    expect(fake.calls.some((c) => c.method === "doTransition")).toBe(false);
  });

  it("does nothing when the toggle is off, when the ticket changed again, or for statuses with no Jira twin", async () => {
    const off = setup({ getIssue: async () => issue(), getTransitions: async () => transitions });
    off.store.tickets[0].status = "in_progress";
    expect((await pushStatus(off.ctx, { ticketId: "t-1", status: "in_progress" })).links).toEqual([]);

    const stale = setup({ getIssue: async () => issue(), getTransitions: async () => transitions }, enabled);
    stale.store.tickets[0].status = "resolved"; // moved on after the job was queued
    expect((await pushStatus(stale.ctx, { ticketId: "t-1", status: "in_progress" })).links).toEqual([]);

    const pending = setup({ getIssue: async () => issue(), getTransitions: async () => transitions }, enabled);
    pending.store.tickets[0].status = "pending";
    const r = await pushStatus(pending.ctx, { ticketId: "t-1", status: "pending" });
    expect(r.links[0].result).toMatchObject({ ok: true, reason: "not_mapped" });
    expect(pending.fake.calls.filter((c) => c.method === "doTransition")).toEqual([]);
  });

  it("a 403 from Jira is a clear result, not an exception (no retry storm)", async () => {
    const { store, ctx } = setup(
      {
        getIssue: async () => issue(),
        getTransitions: async () => transitions,
        doTransition: async () => {
          throw new JiraPermissionError();
        },
      },
      enabled,
    );
    store.tickets[0].status = "in_progress";
    const r = await pushStatus(ctx, { ticketId: "t-1", status: "in_progress" });
    expect(r.links[0].result).toMatchObject({ ok: false, reason: "permission" });
  });

  it("a rate limit propagates so the queue retries later", async () => {
    const { store, ctx } = setup(
      {
        getIssue: async () => issue(),
        getTransitions: async () => {
          throw new JiraRateLimitError(10_000);
        },
      },
      enabled,
    );
    store.tickets[0].status = "in_progress";
    await expect(pushStatus(ctx, { ticketId: "t-1", status: "in_progress" })).rejects.toBeInstanceOf(JiraRateLimitError);
  });
});

describe("Sync now", () => {
  it("is limited to once per 30 seconds per link", async () => {
    const { store, ctx, fake } = setup({ getIssue: async () => issue() });
    const first = await resyncLink(ctx, store.links[0].id);
    expect(first).toMatchObject({ links: 1 });
    const second = await resyncLink(ctx, store.links[0].id);
    expect(second.tooSoonMs).toBe(30_000);
    expect(fake.calls.filter((c) => c.method === "getIssue")).toHaveLength(1);
    expect(resyncWaitMs({ last_resync_at: "2026-09-20T10:04:40.000Z" }, Date.parse("2026-09-20T10:05:00Z"))).toBe(10_000);
    expect(resyncWaitMs({ last_resync_at: null }, 0)).toBe(0);
  });

  it("refuses a link of another workspace", async () => {
    const { store, ctx } = setup({ getIssue: async () => issue() });
    store.links[0].account_id = "someone-else";
    expect(await resyncLink(ctx, store.links[0].id)).toMatchObject({ skipped: "no_links" });
  });
});

describe("no tokens or secrets are ever written to the store", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
  });
  it("the store interface has no method that reads or writes a token", () => {
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(store));
    expect(methods.filter((m) => /token|secret|password/i.test(m))).toEqual([]);
  });
});
