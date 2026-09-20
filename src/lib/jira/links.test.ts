import { describe, expect, it } from "vitest";

import { JiraNotFoundError, JiraPermissionError, JiraValidationError } from "./errors";
import { createIssueFromTicket, LinkError, linkExistingIssue, listTransitions, previewCreate, transitionByHand, unlinkIssue } from "./links";
import { fakeClient, issue, linkRow, makeContext, MemoryStore } from "./test-fakes";

function setup(script: Parameters<typeof fakeClient>[0] = {}, settings: Parameters<typeof makeContext>[2] = {}) {
  const store = new MemoryStore();
  const fake = fakeClient(script);
  return { store, fake, ctx: makeContext(store, fake.client, settings) };
}

const codeOf = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as LinkError).code;

describe("link an existing issue", () => {
  it("stores the link by the PERMANENT issue id, adds the back link in Jira, and logs activity and audit", async () => {
    const { store, fake, ctx } = setup({ getIssue: async () => issue({ id: "10555", key: "ENG-482" }) });
    const link = await linkExistingIssue(ctx, { ticketId: "t-1", reference: "https://acme.atlassian.net/browse/ENG-482", userId: "user-agent" });
    expect(link).toMatchObject({ issue_id: "10555", issue_key: "ENG-482", sync_state: "ok", linked_by: "user-agent", account_id: "acct-1" });
    expect(fake.calls.find((c) => c.method === "getIssue")!.args[0]).toBe("ENG-482");
    const remote = fake.calls.find((c) => c.method === "upsertRemoteLink")!;
    expect(remote.args[0]).toBe("10555");
    expect(remote.args[1]).toMatchObject({ globalId: "vircle:acct-1:ticket:t-1", title: "Vircle ticket VIR-12", url: "https://crm.example.com/tickets/t-1" });
    expect(store.links[0].remote_link_id).toBe("5");
    expect(store.activity).toContainEqual(expect.objectContaining({ eventType: "jira_linked", toValue: "ENG-482", actorId: "user-agent" }));
    expect(store.audits).toEqual([{ action: "linked", entityType: "ticket_jira_link", label: "ENG-482", summary: { ticket: "VIR-12", issue: "ENG-482", created: false } }]);
  });

  it("records existing Jira comments as seen (not imported) and still links if the back link fails", async () => {
    const { store, ctx } = setup({
      getIssue: async () => issue(),
      upsertRemoteLink: async () => {
        throw new JiraPermissionError();
      },
      listComments: async () => ({ comments: [{ id: "1", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "old" }] }] } }], total: 1 }),
    });
    await linkExistingIssue(ctx, { ticketId: "t-1", reference: "ENG-1", userId: "user-agent" });
    expect(store.links).toHaveLength(1);
    expect(store.notes).toEqual([]);
    expect(store.maps).toHaveLength(1);
    expect(store.events.some((e) => e.kind === "remote_link_failed")).toBe(true);
  });

  it("allows at most five links per ticket", async () => {
    const { store, ctx } = setup({ getIssue: async () => issue({ id: "20000", key: "ENG-9" }) });
    for (let i = 1; i <= 5; i++) store.links.push(linkRow({ id: `l${i}`, issue_id: String(10000 + i), issue_key: `ENG-${i}` }));
    expect(await codeOf(linkExistingIssue(ctx, { ticketId: "t-1", reference: "ENG-9", userId: null }))).toBe("link_limit");
  });

  it("also maps the database's own limit trigger to link_limit (a race)", async () => {
    const { store, ctx } = setup({ getIssue: async () => issue({ id: "20000", key: "ENG-9" }) });
    const orig = store.linksForTicket.bind(store);
    store.linksForTicket = async () => []; // the pre-check sees nothing, the trigger sees five
    for (let i = 1; i <= 5; i++) store.links.push(linkRow({ id: `l${i}`, issue_id: String(10000 + i), issue_key: `ENG-${i}` }));
    expect(await codeOf(linkExistingIssue(ctx, { ticketId: "t-1", reference: "ENG-9", userId: null }))).toBe("link_limit");
    store.linksForTicket = orig;
  });

  it("refuses the same issue twice on one ticket, but the issue may be linked from another ticket", async () => {
    const { store, ctx } = setup({ getIssue: async () => issue() });
    store.tickets.push({ ...store.tickets[0], id: "t-2", ticket_number: 13 });
    await linkExistingIssue(ctx, { ticketId: "t-1", reference: "ENG-1", userId: null });
    expect(await codeOf(linkExistingIssue(ctx, { ticketId: "t-1", reference: "ENG-1", userId: null }))).toBe("already_linked");
    const other = await linkExistingIssue(ctx, { ticketId: "t-2", reference: "ENG-1", userId: null });
    expect(other.ticket_id).toBe("t-2");
  });

  it("checks the allowed-projects list", async () => {
    const { ctx } = setup({ getIssue: async () => issue() }, { projects: { allowed: ["WEB"], default_project: null, default_issue_type: null } });
    expect(await codeOf(linkExistingIssue(ctx, { ticketId: "t-1", reference: "ENG-1", userId: null }))).toBe("project_not_allowed");
  });

  it("gives clear errors for a bad reference, a missing issue, an invisible one, another workspace's ticket and a paused connection", async () => {
    expect(await codeOf(setup({}).ctx && linkExistingIssue(setup({}).ctx, { ticketId: "t-1", reference: "not a key", userId: null }))).toBe("bad_reference");
    const missing = setup({ getIssue: async () => { throw new JiraNotFoundError(); } });
    expect(await codeOf(linkExistingIssue(missing.ctx, { ticketId: "t-1", reference: "ENG-404", userId: null }))).toBe("not_found");
    const hidden = setup({ getIssue: async () => { throw new JiraPermissionError(); } });
    expect(await codeOf(linkExistingIssue(hidden.ctx, { ticketId: "t-1", reference: "ENG-1", userId: null }))).toBe("no_permission");
    const foreign = setup({ getIssue: async () => issue() });
    foreign.store.tickets[0].account_id = "another";
    expect(await codeOf(linkExistingIssue(foreign.ctx, { ticketId: "t-1", reference: "ENG-1", userId: null }))).toBe("not_found");
    const paused = setup({ getIssue: async () => issue() });
    paused.ctx.connection.status = "reauth_required";
    expect(await codeOf(linkExistingIssue(paused.ctx, { ticketId: "t-1", reference: "ENG-1", userId: null }))).toBe("inactive");
  });
});

describe("create an issue from a ticket", () => {
  const typeFields = { fields: [{ fieldId: "summary", name: "Summary", required: true }, { fieldId: "labels", name: "Labels", required: false }, { fieldId: "priority", name: "Priority", required: false }] };
  const choices = { projectKey: "ENG", issueTypeId: "10004", issueTypeName: "Bug" };

  it("creates the issue with exactly the previewed fields, stores the link, adds the back link, logs and audits", async () => {
    const { store, fake, ctx } = setup(
      { listCreateFields: async () => typeFields, createIssue: async () => ({ id: "10099", key: "ENG-99" }), getIssue: async () => issue({ id: "10099", key: "ENG-99" }) },
      { mapping: { priority: { high: "High" }, status_from_jira: {}, status_to_jira: {}, category_label: true } },
    );
    const link = await createIssueFromTicket(ctx, { ticketId: "t-1", choices, customer: { name: "Grace", email: "g@x.test" }, userId: "user-agent" });
    expect(link).toMatchObject({ issue_id: "10099", issue_key: "ENG-99" });
    const sent = fake.calls.find((c) => c.method === "createIssue")!.args[0] as Record<string, unknown>;
    expect(sent).toMatchObject({ project: { key: "ENG" }, issuetype: { id: "10004" }, summary: "Login fails on Safari", labels: ["vircle", "bug"], priority: { name: "High" } });
    expect(JSON.stringify(sent)).not.toContain("Grace"); // customer excluded by default
    // the preview builds the very same request
    const { plan } = await previewCreate(ctx, { ticketId: "t-1", choices, customer: { name: "Grace", email: "g@x.test" } });
    expect(plan.fields).toEqual(sent);
    expect(fake.calls.some((c) => c.method === "upsertRemoteLink")).toBe(true);
    expect(store.audits[0]).toMatchObject({ action: "linked", summary: expect.objectContaining({ created: true }) });
    expect(store.activity[0]).toMatchObject({ eventType: "jira_linked", detail: "created" });
  });

  it("shows 'Open in Jira instead' data: a required field of an unsupported type stops the create", async () => {
    const { ctx, fake } = setup({ listCreateFields: async () => ({ fields: [...typeFields.fields, { fieldId: "customfield_77", name: "Cascade picker", required: true, schema: { type: "option-with-child" } }] }) });
    const err = (await createIssueFromTicket(ctx, { ticketId: "t-1", choices, customer: null, userId: null }).catch((e) => e)) as LinkError;
    expect(err).toBeInstanceOf(LinkError);
    expect(err.code).toBe("unsupported_fields");
    expect(err.detail).toEqual({ fields: ["Cascade picker"] });
    expect(fake.calls.some((c) => c.method === "createIssue")).toBe(false);
  });

  it("asks for a supported required field, refuses an empty one, and sends the filled one", async () => {
    const script = {
      listCreateFields: async () => ({ fields: [...typeFields.fields, { fieldId: "customfield_5", name: "Environment", required: true, schema: { type: "option" }, allowedValues: [{ id: "1", value: "Prod" }] }] }),
      createIssue: async () => ({ id: "10100", key: "ENG-100" }),
      getIssue: async () => issue({ id: "10100", key: "ENG-100" }),
    };
    const a = setup(script);
    const preview = await previewCreate(a.ctx, { ticketId: "t-1", choices, customer: null });
    expect(preview.required.ask.map((x) => x.field.fieldId)).toEqual(["customfield_5"]);
    expect(await codeOf(createIssueFromTicket(a.ctx, { ticketId: "t-1", choices, customer: null, userId: null }))).toBe("missing_fields");
    const b = setup(script);
    await createIssueFromTicket(b.ctx, { ticketId: "t-1", choices, rawFieldValues: { customfield_5: "1" }, customer: null, userId: null });
    expect((b.fake.calls.find((c) => c.method === "createIssue")!.args[0] as Record<string, unknown>).customfield_5).toEqual({ id: "1" });
  });

  it("maps Jira's validation errors to field messages and a 403 to no_permission", async () => {
    const rejected = setup({ listCreateFields: async () => typeFields, createIssue: async () => { throw new JiraValidationError(["bad"], { summary: "too long" }); } });
    const err = (await createIssueFromTicket(rejected.ctx, { ticketId: "t-1", choices, customer: null, userId: null }).catch((e) => e)) as LinkError;
    expect(err.code).toBe("jira_rejected");
    expect(err.detail).toMatchObject({ fieldErrors: { summary: "too long" } });
    const denied = setup({ listCreateFields: async () => typeFields, createIssue: async () => { throw new JiraPermissionError(); } });
    expect(await codeOf(createIssueFromTicket(denied.ctx, { ticketId: "t-1", choices, customer: null, userId: null }))).toBe("no_permission");
  });

  it("still links when the read-back fails, and reports a link that could not be saved", async () => {
    const { store, ctx } = setup({ listCreateFields: async () => typeFields, createIssue: async () => ({ id: "10101", key: "ENG-101" }), getIssue: async () => { throw new Error("boom"); } });
    const link = await createIssueFromTicket(ctx, { ticketId: "t-1", choices, customer: null, userId: null });
    expect(link).toMatchObject({ issue_key: "ENG-101", summary: "Login fails on Safari" });
    expect(store.links).toHaveLength(1);
  });

  it("refuses when the ticket already has five links or the project is not allowed", async () => {
    const full = setup({ listCreateFields: async () => typeFields });
    for (let i = 1; i <= 5; i++) full.store.links.push(linkRow({ id: `l${i}`, issue_id: String(10000 + i) }));
    expect(await codeOf(createIssueFromTicket(full.ctx, { ticketId: "t-1", choices, customer: null, userId: null }))).toBe("link_limit");
    const blocked = setup({ listCreateFields: async () => typeFields }, { projects: { allowed: ["WEB"], default_project: null, default_issue_type: null } });
    expect(await codeOf(createIssueFromTicket(blocked.ctx, { ticketId: "t-1", choices, customer: null, userId: null }))).toBe("project_not_allowed");
  });
});

describe("unlink and manual transitions", () => {
  it("unlink removes the link and its comment map, deletes NOTHING in Jira, and is logged", async () => {
    const { store, fake, ctx } = setup();
    store.links.push(linkRow({ id: "l1" }));
    store.maps.push({ id: "m", account_id: "acct-1", link_id: "l1", ticket_comment_id: null, jira_comment_id: "1", origin: "jira", jira_author_account_id: null, body_hash: null, jira_updated_at: null, deleted_in_jira: false });
    await unlinkIssue(ctx, { linkId: "l1", userId: "user-agent" });
    expect(store.links).toEqual([]);
    expect(store.maps).toEqual([]);
    expect(fake.calls).toEqual([]); // no Jira call at all
    expect(store.activity).toContainEqual(expect.objectContaining({ eventType: "jira_unlinked", toValue: "ENG-1" }));
    expect(store.audits[0]).toMatchObject({ action: "unlinked", entityType: "ticket_jira_link", label: "ENG-1" });
    expect(await codeOf(unlinkIssue(ctx, { linkId: "l1", userId: null }))).toBe("not_found");
  });

  it("cannot unlink another workspace's link", async () => {
    const { store, ctx } = setup();
    store.links.push(linkRow({ id: "l1", account_id: "another" }));
    expect(await codeOf(unlinkIssue(ctx, { linkId: "l1", userId: null }))).toBe("not_found");
    expect(store.links).toHaveLength(1);
  });

  const transitions = {
    transitions: [
      { id: "11", name: "Start", to: { id: "2", name: "In Progress", statusCategory: { key: "indeterminate" } }, isAvailable: true },
      { id: "99", name: "Hidden", to: { id: "9", name: "Hidden", statusCategory: { key: "new" } }, isAvailable: false },
      { id: "31", name: "Finish", to: { id: "3", name: "Done", statusCategory: { key: "done" } }, isAvailable: true, fields: { customfield_1: { required: true, name: "Root cause" } } },
    ],
  };

  it("lists only the transitions the issue offers right now, marking the ones Vircle cannot complete", async () => {
    const { store, ctx } = setup({ getTransitions: async () => transitions });
    store.links.push(linkRow({ id: "l1" }));
    expect(await listTransitions(ctx, "l1")).toEqual([
      { id: "11", name: "Start", to: "In Progress", category: "indeterminate", blocked: false },
      { id: "31", name: "Finish", to: "Done", category: "done", blocked: true },
    ]);
  });

  it("moves the issue with the chosen transition, remembers what was written, and refuses one that is gone", async () => {
    const { store, fake, ctx } = setup({ getTransitions: async () => transitions });
    store.links.push(linkRow({ id: "l1" }));
    await transitionByHand(ctx, { linkId: "l1", transitionId: "11", userId: "user-agent" });
    expect(fake.calls.find((c) => c.method === "doTransition")!.args.slice(0, 2)).toEqual(["10001", "11"]);
    expect(store.links[0]).toMatchObject({ status_name: "In Progress", status_category: "indeterminate" });
    expect(store.links[0].last_written).toMatchObject({ status_category: "indeterminate" });
    expect(store.activity).toContainEqual(expect.objectContaining({ eventType: "jira_status_pushed", toValue: "In Progress", actorId: "user-agent" }));
    expect(await codeOf(transitionByHand(ctx, { linkId: "l1", transitionId: "99", userId: null }))).toBe("transition_unavailable");
    expect(await codeOf(transitionByHand(ctx, { linkId: "l1", transitionId: "31", userId: null }))).toBe("unsupported_fields");
  });

  it("says plainly when Jira forbids the transition", async () => {
    const { store, ctx } = setup({ getTransitions: async () => transitions, doTransition: async () => { throw new JiraPermissionError(); } });
    store.links.push(linkRow({ id: "l1" }));
    expect(await codeOf(transitionByHand(ctx, { linkId: "l1", transitionId: "11", userId: null }))).toBe("no_permission");
  });
});
