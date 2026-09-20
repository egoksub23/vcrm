import { describe, expect, it } from "vitest";

import { buildCreatePlan } from "./create-issue";
import { linkExistingIssue, planFor } from "./links";
import { applySettingsPatch, attachmentsAutoSend, changedSections, directionOnAnywhere, effectiveSettings, normalizeProjectOverride, normalizeSettings } from "./settings";
import { pushStatus, shareNoteToJira, syncIssue } from "./sync";
import { fakeClient, issue, linkRow, makeContext, MemoryStore } from "./test-fakes";
import { DEFAULT_JIRA_SETTINGS, type JiraSettings } from "./types";

const base = (over: Record<string, unknown> = {}): JiraSettings =>
  normalizeSettings({
    projects: { allowed: [], default_project: "ENG", default_issue_type: "Task" },
    mapping: { priority: { urgent: "Highest", high: "High" }, category_label: true },
    direction: { comments_to_jira: true, status_to_jira: false },
    ...over,
  });

describe("normalising overrides", () => {
  it("keeps valid entries, upper-cases the key, drops unknown keys and empty overrides", () => {
    const s = normalizeSettings({
      project_overrides: {
        eng: { issue_type: "  Bug ", priority: { urgent: "Blocker", bogus: "x" }, category_label: false, direction: { status_to_jira: true, nonsense: true, assignee: "yes" }, evil: 1 },
        "bad key!": { issue_type: "X" },
        OPS: {},
        WEB: null,
        QA: { direction: {} },
      },
    });
    expect(s.project_overrides).toEqual({
      ENG: { issue_type: "Bug", priority: { urgent: "Blocker" }, category_label: false, direction: { status_to_jira: true } },
    });
  });

  it("is safe with garbage", () => {
    expect(normalizeSettings({ project_overrides: "nope" }).project_overrides).toEqual({});
    expect(normalizeSettings({ project_overrides: [1, 2] }).project_overrides).toEqual({});
    expect(normalizeProjectOverride("x")).toBeNull();
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_JIRA_SETTINGS);
  });

  it("caps the number of overrides", () => {
    const many = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`P${i}`, { issue_type: "Bug" }]));
    expect(Object.keys(normalizeSettings({ project_overrides: many }).project_overrides).length).toBeLessThanOrEqual(100);
  });

  it("the new direction toggles and the webhook setting default off and round-trip", () => {
    const d = normalizeSettings({});
    expect(d.direction).toMatchObject({ attachments: false, attachments_auto: false });
    expect(d.webhook.require_signed).toBe(false);
    const on = normalizeSettings({ direction: { attachments: true, attachments_auto: true }, webhook: { require_signed: true } });
    expect(on.direction).toMatchObject({ attachments: true, attachments_auto: true });
    expect(on.webhook.require_signed).toBe(true);
    expect(attachmentsAutoSend(on)).toBe(true);
    expect(attachmentsAutoSend(normalizeSettings({ direction: { attachments: false, attachments_auto: true } }))).toBe(false);
  });

  it("a patch adds, changes and (with null) removes one project's override without touching the others", () => {
    let s = base();
    s = applySettingsPatch(s, { project_overrides: { ENG: { issue_type: "Bug" }, OPS: { category_label: false } } });
    expect(Object.keys(s.project_overrides).sort()).toEqual(["ENG", "OPS"]);
    s = applySettingsPatch(s, { project_overrides: { ENG: null } });
    expect(Object.keys(s.project_overrides)).toEqual(["OPS"]);
  });

  it("changes to overrides and the webhook choice are audited by section name", () => {
    const a = base();
    const b = applySettingsPatch(a, { project_overrides: { ENG: { issue_type: "Bug" } }, webhook: { require_signed: true } });
    expect(changedSections(a, b).sort()).toEqual(["project_overrides", "webhook"]);
  });
});

describe("resolution order: project override, then workspace, then built-in default", () => {
  it("issue type", () => {
    const s = base({ project_overrides: { OPS: { issue_type: "Incident" } } });
    expect(effectiveSettings(s, "OPS").projects.default_issue_type).toBe("Incident");
    expect(effectiveSettings(s, "ops").projects.default_issue_type).toBe("Incident");
    expect(effectiveSettings(s, "ENG").projects.default_issue_type).toBe("Task"); // workspace
    expect(effectiveSettings(normalizeSettings({}), "ENG").projects.default_issue_type).toBeNull(); // built-in default
  });

  it("priority map merges entry by entry: the project's entry wins, the rest inherit", () => {
    const s = base({ project_overrides: { OPS: { priority: { urgent: "Blocker" } } } });
    expect(effectiveSettings(s, "OPS").mapping.priority).toEqual({ urgent: "Blocker", high: "High" });
    expect(effectiveSettings(s, "ENG").mapping.priority).toEqual({ urgent: "Highest", high: "High" });
  });

  it("category label and component: inherit unless the project says", () => {
    const s = base({ mapping: { category_label: true, category_component: false }, project_overrides: { OPS: { category_label: false, category_component: true } } });
    expect(effectiveSettings(s, "OPS").mapping).toMatchObject({ category_label: false, category_component: true });
    expect(effectiveSettings(s, "ENG").mapping).toMatchObject({ category_label: true, category_component: false });
  });

  it("each direction toggle inherits or overrides on its own", () => {
    const s = base({ direction: { comments_to_jira: true, status_to_jira: false, assignee: false }, project_overrides: { OPS: { direction: { status_to_jira: true, comments_to_jira: false } } } });
    expect(effectiveSettings(s, "OPS").direction).toMatchObject({ status_to_jira: true, comments_to_jira: false, assignee: false, comments_from_jira: true });
    expect(effectiveSettings(s, "ENG").direction).toMatchObject({ status_to_jira: false, comments_to_jira: true });
  });

  it("an unknown or missing project uses the workspace settings untouched", () => {
    const s = base({ project_overrides: { OPS: { issue_type: "X" } } });
    expect(effectiveSettings(s, null)).toBe(s);
    expect(effectiveSettings(s, undefined)).toBe(s);
    expect(effectiveSettings(s, "NOPE")).toBe(s);
  });

  it("directionOnAnywhere sees a project that switches something on (what the SQL triggers ask)", () => {
    expect(directionOnAnywhere(base(), "status_to_jira")).toBe(false);
    expect(directionOnAnywhere(base({ project_overrides: { OPS: { direction: { status_to_jira: true } } } }), "status_to_jira")).toBe(true);
    expect(directionOnAnywhere(base({ project_overrides: { OPS: { direction: { status_to_jira: false } } } }), "status_to_jira")).toBe(false);
  });
});

describe("the backend uses the most specific setting", () => {
  it("the create plan takes the project's priority map and category label", () => {
    const ticket = { ticket_number: 1, subject: "S", description: null, category: "billing", priority: "urgent" as const };
    const args = { ticket, customer: null, ticketKey: "VIR-1", ticketUrl: null, choices: { projectKey: "OPS", issueTypeId: "1" } };
    const s = base({ project_overrides: { OPS: { priority: { urgent: "Blocker" }, category_label: false } } });
    const ops = buildCreatePlan({ ...args, settings: effectiveSettings(s, "OPS") });
    expect(ops.fields.priority).toEqual({ name: "Blocker" });
    expect(ops.fields.labels).toEqual(["vircle"]);
    const eng = buildCreatePlan({ ...args, choices: { projectKey: "ENG", issueTypeId: "1" }, settings: effectiveSettings(s, "ENG") });
    expect(eng.fields.priority).toEqual({ name: "Highest" });
    expect(eng.fields.labels).toEqual(["vircle", "billing"]);
  });

  it("planFor (the create dialog and the bulk review) resolves the overrides for the chosen project, and adds the category component when asked", async () => {
    const store = new MemoryStore();
    const fake = fakeClient({
      listCreateFields: async () => ({ fields: [{ fieldId: "components", name: "Components", required: false, schema: { type: "array", items: "component", system: "components" } }, { fieldId: "priority", name: "Priority", required: false }, { fieldId: "labels", name: "Labels", required: false }] }),
      listProjectComponents: async () => [{ id: "77", name: "Bug" }],
    });
    const ctx = makeContext(store, fake.client, {
      ...base({ mapping: { priority: { high: "High" }, category_label: true }, project_overrides: { OPS: { priority: { high: "Blocker" }, category_label: false, category_component: true } } }),
    });
    const ops = await planFor(ctx, "t-1", { projectKey: "OPS", issueTypeId: "1" }, null);
    expect(ops.plan.fields.priority).toEqual({ name: "Blocker" });
    expect(ops.plan.fields.labels).toEqual(["vircle"]);
    expect(ops.plan.fields.components).toEqual([{ id: "77" }]);
    expect(ops.plan.preview.component).toBe("Bug");
    const eng = await planFor(ctx, "t-1", { projectKey: "ENG", issueTypeId: "1" }, null);
    expect(eng.plan.fields.priority).toEqual({ name: "High" });
    expect(eng.plan.fields.components).toBeUndefined();
    expect(eng.plan.fields.labels).toEqual(["vircle", "bug"]);
    // a component the project does not have is simply left out
    const none = fakeClient({ listCreateFields: async () => ({ fields: [{ fieldId: "components", name: "C", required: false }] }), listProjectComponents: async () => [{ id: "1", name: "Other" }] });
    const c2 = makeContext(store, none.client, { ...base({ project_overrides: { OPS: { category_component: true } } }) });
    expect((await planFor(c2, "t-1", { projectKey: "OPS", issueTypeId: "1" }, null)).plan.fields.components).toBeUndefined();
  });

  it("status to Jira: a project can switch it on (or off) for its own issues only", async () => {
    const store = new MemoryStore();
    store.tickets[0].status = "in_progress";
    store.links.push(linkRow({ id: "eng", issue_id: "1", issue_key: "ENG-1", project_key: "ENG" }), linkRow({ id: "ops", issue_id: "2", issue_key: "OPS-1", project_key: "OPS" }));
    const moved: string[] = [];
    const fake = fakeClient({
      getIssue: async (id) => issue({ id, key: id === "1" ? "ENG-1" : "OPS-1", status: { id: "1", name: "To Do", category: "new" } }),
      getTransitions: async () => ({ transitions: [{ id: "31", to: { id: "3", name: "In Progress", statusCategory: { key: "indeterminate" } } }] }),
      doTransition: async (id) => {
        moved.push(id);
        return null;
      },
    });
    const ctx = makeContext(store, fake.client, base({ direction: { status_to_jira: false }, project_overrides: { OPS: { direction: { status_to_jira: true } } } }));
    const r = await pushStatus(ctx, { ticketId: "t-1", status: "in_progress" });
    expect(r.links.map((l) => l.key)).toEqual(["OPS-1"]);
    expect(moved).toEqual(["2"]);
    // nothing on anywhere: nothing at all
    const none = makeContext(store, fakeClient().client, base());
    expect((await pushStatus(none, { ticketId: "t-1", status: "in_progress" })).links).toEqual([]);
  });

  it("comments to Jira: a project that switches it off keeps its issues out of Share with Jira", async () => {
    const store = new MemoryStore();
    store.links.push(linkRow({ id: "ops", issue_id: "2", issue_key: "OPS-1", project_key: "OPS" }));
    const note = store.addAgentNote("hello");
    const fake = fakeClient();
    const ctx = makeContext(store, fake.client, base({ project_overrides: { OPS: { direction: { comments_to_jira: false } } } }));
    expect((await shareNoteToJira(ctx, { noteId: note.id, actorUserId: "user-agent" }))[0].code).toBe("toggle_off");
    expect(fake.calls.filter((c) => c.method === "addComment")).toHaveLength(0);
    store.links.push(linkRow({ id: "eng", issue_id: "1", issue_key: "ENG-1", project_key: "ENG" }));
    const both = await shareNoteToJira(ctx, { noteId: note.id, actorUserId: "user-agent" });
    expect(both.map((r) => [r.key, r.code])).toEqual([["ENG-1", "shared"]]);
  });

  it("status from Jira follows the issue's project override", async () => {
    const run = async (settings: JiraSettings) => {
      const store = new MemoryStore();
      store.links.push(linkRow({ id: "ops", issue_id: "10001", issue_key: "OPS-1", project_key: "OPS" }));
      const inProgress = issue({ status: { id: "2", name: "In Progress", category: "indeterminate" } });
      inProgress.fields.project = { id: "9", key: "OPS", name: "Ops" };
      const ctx = makeContext(store, fakeClient({ getIssue: async () => inProgress }).client, settings);
      await syncIssue(ctx, "10001", { comments: false });
      return store.tickets[0].status;
    };
    expect(await run(base({ project_overrides: { OPS: { direction: { status_from_jira: false } } } }))).toBe("open"); // OPS said no
    expect(await run(base())).toBe("in_progress");
  });

  it("linking still enforces the allow-list, whatever the overrides say", async () => {
    const store = new MemoryStore();
    const fake = fakeClient({ getIssue: async () => issue({ key: "OPS-5" }) });
    const ctx = makeContext(store, fake.client, base({ projects: { allowed: ["ENG"], default_project: "ENG" }, project_overrides: { OPS: { issue_type: "Bug" } } }));
    await expect(linkExistingIssue(ctx, { ticketId: "t-1", reference: "OPS-5", userId: "u" })).resolves.toBeDefined(); // issue() reports project ENG
  });
});
