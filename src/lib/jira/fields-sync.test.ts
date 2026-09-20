import { describe, expect, it } from "vitest";

import { JiraPermissionError, JiraRateLimitError, JiraValidationError } from "./errors";
import { hashNorm } from "./field-echo";
import { buildMappedCreateFields, pullFieldsIntoTicket, pushFieldChanges } from "./fields-sync";
import type { FieldMappingRow, VircleFieldDef } from "./field-mapping";
import { createIssueFromTicket, previewCreate } from "./links";
import { syncIssue } from "./sync";
import { fakeClient, issue, linkRow, makeContext, MemoryStore, ticketRow } from "./test-fakes";

const CF = "com.atlassian.jira.plugin.system.customfieldtypes:";

const DEFS: VircleFieldDef[] = [
  { id: "fd-browser", label: "Browser", field_type: "text", options: [] },
  { id: "fd-sev", label: "Severity", field_type: "dropdown", options: ["Low", "High"] },
  { id: "fd-vip", label: "VIP", field_type: "checkbox", options: [] },
  { id: "fd-pts", label: "Points", field_type: "number", options: [] },
];

const mapping = (over: Partial<FieldMappingRow>): FieldMappingRow => ({
  id: "m-browser",
  account_id: "acct-1",
  connection_id: "conn-1",
  project_key: "ENG",
  ticket_field_id: "fd-browser",
  jira_field_id: "customfield_1",
  jira_field_name: "Browser",
  jira_kind: "text",
  direction: "both",
  when_missing: "skip",
  default_value: null,
  config: null,
  ...over,
});

const MAPS = [
  mapping({}),
  mapping({ id: "m-sev", ticket_field_id: "fd-sev", jira_field_id: "customfield_4", jira_field_name: "Severity", jira_kind: "select" }),
  mapping({ id: "m-vip", ticket_field_id: "fd-vip", jira_field_id: "customfield_5", jira_field_name: "VIP", jira_kind: "multicheckbox", direction: "to_jira" }),
];

const EDIT_META = {
  fields: {
    customfield_1: { name: "Browser", required: false, operations: ["set"], schema: { type: "string", custom: `${CF}textfield` } },
    customfield_4: {
      name: "Severity",
      required: false,
      operations: ["set"],
      schema: { type: "option", custom: `${CF}select` },
      allowedValues: [
        { id: "10", value: "Low" },
        { id: "11", value: "High" },
      ],
    },
    customfield_5: {
      name: "VIP",
      required: false,
      operations: ["set"],
      schema: { type: "array", items: "option", custom: `${CF}multicheckboxes` },
      allowedValues: [{ id: "20", value: "Yes" }],
    },
  },
};

function setup(over: { custom?: Record<string, unknown>; mappings?: FieldMappingRow[]; script?: Parameters<typeof fakeClient>[0] } = {}) {
  const store = new MemoryStore();
  store.tickets[0] = ticketRow({ custom_fields: over.custom ?? {} });
  store.fieldDefs = DEFS;
  store.fieldMappings = over.mappings ?? MAPS;
  store.links.push(linkRow({ issue_id: "10001", issue_key: "ENG-1" }));
  const fake = fakeClient({ getEditMeta: async () => EDIT_META, ...over.script });
  const ctx = makeContext(store, fake.client);
  return { store, ctx, fake, link: store.links[0] };
}

const updates = (fake: ReturnType<typeof fakeClient>) => fake.calls.filter((c) => c.method === "updateIssue");

describe("Vircle -> Jira: pushFieldChanges", () => {
  it("sends only the fields that changed, as ONE PUT, and remembers what it wrote", async () => {
    const { store, ctx, fake, link } = setup({ custom: { "fd-browser": "Safari 17", "fd-sev": "High", "fd-vip": true } });
    const r = await pushFieldChanges(ctx, { ticketId: "t-1" });
    expect(r.links[0].pushed.sort()).toEqual(["customfield_1", "customfield_4", "customfield_5"]);
    expect(updates(fake)).toHaveLength(1);
    expect(updates(fake)[0].args).toEqual([
      "10001",
      { fields: { customfield_1: "Safari 17", customfield_4: { id: "11" }, customfield_5: [{ id: "20" }] } },
    ]);
    expect(link.field_state?.["m-browser"]).toMatchObject({ vircle: hashNorm("Safari 17"), jira: hashNorm("Safari 17") });

    // Nothing changed since: no Jira call at all (not even the edit metadata).
    const before = fake.calls.length;
    const again = await pushFieldChanges(ctx, { ticketId: "t-1" });
    expect(again.links).toEqual([]);
    expect(fake.calls.length).toBe(before);
    expect(store.events.some((e) => e.kind === "fields_pushed")).toBe(true);
  });

  it("after one field changes, only that field goes", async () => {
    const { store, ctx, fake } = setup({ custom: { "fd-browser": "Safari 17", "fd-sev": "High" } });
    await pushFieldChanges(ctx, { ticketId: "t-1" });
    store.tickets[0].custom_fields = { "fd-browser": "Safari 18", "fd-sev": "High" };
    await pushFieldChanges(ctx, { ticketId: "t-1" });
    expect(updates(fake)).toHaveLength(2);
    expect(updates(fake)[1].args[1]).toEqual({ fields: { customfield_1: "Safari 18" } });
  });

  it("clears a field when 'when missing' says clear and the value was removed", async () => {
    const maps = [mapping({ when_missing: "clear" })];
    const { store, ctx, fake } = setup({ custom: { "fd-browser": "x" }, mappings: maps });
    await pushFieldChanges(ctx, { ticketId: "t-1" });
    store.tickets[0].custom_fields = {};
    await pushFieldChanges(ctx, { ticketId: "t-1" });
    expect(updates(fake)[1].args[1]).toEqual({ fields: { customfield_1: null } });
  });

  it("with 'skip' an empty value writes nothing and calls nothing", async () => {
    const { ctx, fake } = setup({ custom: {} });
    await pushFieldChanges(ctx, { ticketId: "t-1" });
    expect(updates(fake)).toHaveLength(0);
  });

  it("does not push from-Jira-only mappings, other projects' mappings, or fields not on the edit screen", async () => {
    const maps = [
      mapping({ direction: "from_jira" }),
      mapping({ id: "other-project", project_key: "OPS", ticket_field_id: "fd-pts", jira_field_id: "customfield_3", jira_kind: "number" }),
      mapping({ id: "not-on-screen", ticket_field_id: "fd-sev", jira_field_id: "customfield_404", jira_kind: "select" }),
    ];
    const { ctx, fake } = setup({ custom: { "fd-browser": "x", "fd-pts": 3, "fd-sev": "High" }, mappings: maps });
    const r = await pushFieldChanges(ctx, { ticketId: "t-1" });
    expect(updates(fake)).toHaveLength(0);
    expect(r.links[0]?.skipped ?? 0).toBe(1); // the one that is not on the screen
  });

  it("skips a dropdown choice Jira does not have, still pushes the rest", async () => {
    const { ctx, fake } = setup({ custom: { "fd-browser": "x", "fd-sev": "Low" }, script: { getEditMeta: async () => ({ fields: { ...EDIT_META.fields, customfield_4: { ...EDIT_META.fields.customfield_4, allowedValues: [{ id: "11", value: "High" }] } } }) } });
    await pushFieldChanges(ctx, { ticketId: "t-1" });
    expect(updates(fake)[0].args[1]).toEqual({ fields: { customfield_1: "x" } });
  });

  it("a rejected or forbidden write is logged, not thrown; a rate limit goes back to the queue", async () => {
    const rejected = setup({ custom: { "fd-browser": "x" }, script: { updateIssue: async () => { throw new JiraValidationError([], { customfield_1: "not on screen" }); } } });
    const r = await pushFieldChanges(rejected.ctx, { ticketId: "t-1" });
    expect(r.links[0].error).toBe("rejected");
    expect(rejected.store.events.find((e) => e.kind === "fields_push_failed")).toMatchObject({ level: "warn", details: { fieldErrors: { customfield_1: "not on screen" } } });
    expect(rejected.link.field_state ?? {}).toEqual({}); // nothing remembered: a later edit tries again

    const denied = setup({ custom: { "fd-browser": "x" }, script: { updateIssue: async () => { throw new JiraPermissionError(); } } });
    expect((await pushFieldChanges(denied.ctx, { ticketId: "t-1" })).links[0].error).toBe("permission");

    const limited = setup({ custom: { "fd-browser": "x" }, script: { updateIssue: async () => { throw new JiraRateLimitError(5000); } } });
    await expect(pushFieldChanges(limited.ctx, { ticketId: "t-1" })).rejects.toBeInstanceOf(JiraRateLimitError);
  });

  it("does nothing for a paused link or an inactive connection", async () => {
    const paused = setup({ custom: { "fd-browser": "x" } });
    paused.link.sync_state = "paused";
    expect((await pushFieldChanges(paused.ctx, { ticketId: "t-1" })).links).toEqual([]);
    const inactive = setup({ custom: { "fd-browser": "x" } });
    inactive.store.connections[0].status = "reauth_required";
    expect((await pushFieldChanges(inactive.ctx, { ticketId: "t-1" })).links).toEqual([]);
  });
});

describe("Jira -> Vircle: pullFieldsIntoTicket", () => {
  const readIssue = (fields: Record<string, unknown>) => {
    const i = issue({});
    Object.assign(i.fields, fields);
    return i;
  };

  it("records what it sees the first time and imports nothing", async () => {
    const { store, ctx, link } = setup({ custom: {} });
    const r = await pullFieldsIntoTicket(ctx, link, readIssue({ customfield_1: "Firefox", customfield_4: { id: "11", value: "High" } }), store.tickets[0], MAPS);
    expect(r).toMatchObject({ seeded: 2, applied: [] });
    expect(store.appliedFields).toEqual([]);
    expect(link.field_state?.["m-browser"]?.jira).toBe(hashNorm("Firefox"));
  });

  it("applies a value Jira changed and remembers it, so it is not pushed back", async () => {
    const { store, ctx, fake, link } = setup({ custom: { "fd-browser": "Safari" } });
    await pullFieldsIntoTicket(ctx, link, readIssue({ customfield_1: "Safari" }), store.tickets[0], MAPS); // seed
    const r = await pullFieldsIntoTicket(ctx, link, readIssue({ customfield_1: "Firefox", customfield_4: null }), store.tickets[0], MAPS);
    expect(r.applied).toContain("customfield_1");
    expect(store.appliedFields.at(-1)).toEqual({ ticketId: "t-1", values: { "fd-browser": "Firefox" } });
    expect(store.tickets[0].custom_fields).toEqual({ "fd-browser": "Firefox" });
    // The ticket edit that follows the apply is recognised as unchanged: no PUT.
    await pushFieldChanges(ctx, { ticketId: "t-1" });
    expect(updates(fake)).toHaveLength(0);
  });

  it("our own push coming back is an echo: nothing applied", async () => {
    const { store, ctx, link } = setup({ custom: { "fd-browser": "Safari 17" } });
    await pushFieldChanges(ctx, { ticketId: "t-1" });
    const r = await pullFieldsIntoTicket(ctx, link, readIssue({ customfield_1: "Safari 17" }), store.tickets[0], MAPS);
    expect(r.applied).toEqual([]);
    expect(store.appliedFields).toEqual([]);
  });

  it("Jira truncating what we wrote (255 characters) is not mistaken for a Jira change", async () => {
    const long = "y".repeat(400);
    const { store, ctx, link } = setup({ custom: { "fd-browser": long } });
    await pushFieldChanges(ctx, { ticketId: "t-1" });
    const r = await pullFieldsIntoTicket(ctx, link, readIssue({ customfield_1: "y".repeat(255) }), store.tickets[0], MAPS);
    expect(r.applied).toEqual([]);
    expect(store.tickets[0].custom_fields).toEqual({ "fd-browser": long });
  });

  it("an unchanged Jira value applies nothing, and a to-Jira-only mapping is never read", async () => {
    const { store, ctx, link } = setup({ custom: {} });
    await pullFieldsIntoTicket(ctx, link, readIssue({ customfield_1: "A", customfield_5: [{ id: "20" }] }), store.tickets[0], MAPS);
    const r = await pullFieldsIntoTicket(ctx, link, readIssue({ customfield_1: "A", customfield_5: [] }), store.tickets[0], MAPS);
    expect(r).toMatchObject({ applied: [], seeded: 0 });
    expect(link.field_state?.["m-vip"]).toBeUndefined();
  });

  it("a dropdown value the Vircle field lacks is ignored", async () => {
    const { store, ctx, link } = setup({ custom: {} });
    await pullFieldsIntoTicket(ctx, link, readIssue({ customfield_4: { id: "11", value: "High" } }), store.tickets[0], MAPS);
    const r = await pullFieldsIntoTicket(ctx, link, readIssue({ customfield_4: { id: "99", value: "Blocker" } }), store.tickets[0], MAPS);
    expect(r.applied).toEqual([]);
  });

  it("empty in Jira: 'skip' keeps the ticket value, 'clear' clears it, 'default' sets the default", async () => {
    for (const [when, expected] of [
      ["skip", { "fd-browser": "keep" }],
      ["clear", {}],
      ["default", { "fd-browser": "n/a" }],
    ] as const) {
      const maps = [mapping({ when_missing: when, default_value: "n/a" })];
      const { store, ctx, link } = setup({ custom: { "fd-browser": "keep" }, mappings: maps });
      await pullFieldsIntoTicket(ctx, link, readIssue({ customfield_1: "was set" }), store.tickets[0], maps); // seed
      await pullFieldsIntoTicket(ctx, link, readIssue({ customfield_1: null }), store.tickets[0], maps);
      expect(store.tickets[0].custom_fields, when).toEqual(expected);
    }
  });

  it("ignores a field that was not part of the read", async () => {
    const { store, ctx, link } = setup({ custom: {} });
    const r = await pullFieldsIntoTicket(ctx, link, readIssue({}), store.tickets[0], MAPS);
    expect(r).toMatchObject({ applied: [], seeded: 0, echoes: 0 });
  });
});

describe("the sync worker asks for the mapped fields and applies them (echo suppressed end to end)", () => {
  it("reads the mapped field ids with the issue, applies a Jira change, and a webhook for our own push changes nothing", async () => {
    const seen: string[][] = [];
    let jiraValue: unknown = "Safari";
    const { store, ctx, fake } = setup({
      custom: { "fd-browser": "Safari" },
      script: {
        getIssue: async (_id: string, fields?: never) => {
          seen.push(fields as unknown as string[]);
          const i = issue({});
          i.fields.customfield_1 = jiraValue;
          i.fields.customfield_4 = null;
          return i;
        },
      },
    });
    await syncIssue(ctx, "10001", { comments: false });
    expect(seen[0]).toEqual(expect.arrayContaining(["summary", "status", "customfield_1", "customfield_4"]));
    expect(seen[0]).not.toContain("customfield_5"); // to-Jira-only: never read
    expect(seen[0]).not.toContain("attachment"); // attachments are off

    jiraValue = "Firefox";
    await syncIssue(ctx, "10001", { comments: false });
    expect(store.tickets[0].custom_fields).toEqual({ "fd-browser": "Firefox" });
    expect(updates(fake)).toHaveLength(0);

    // The agent edits the ticket: pushed once; the webhook that announces it is an echo.
    store.tickets[0].custom_fields = { "fd-browser": "Edge" };
    await pushFieldChanges(ctx, { ticketId: "t-1" });
    expect(updates(fake)).toHaveLength(1);
    jiraValue = "Edge";
    await syncIssue(ctx, "10001", { comments: false });
    expect(store.appliedFields).toHaveLength(1); // only the Firefox one
    expect(store.tickets[0].custom_fields).toEqual({ "fd-browser": "Edge" });
  });
});

describe("create: the mapped fields", () => {
  const createFields = [
    { fieldId: "customfield_1", name: "Browser", required: false, schema: { type: "string", custom: `${CF}textfield` } },
    {
      fieldId: "customfield_4",
      name: "Severity",
      required: true,
      schema: { type: "option", custom: `${CF}select` },
      allowedValues: [
        { id: "10", value: "Low" },
        { id: "11", value: "High" },
      ],
    },
    { fieldId: "labels", name: "Labels", required: false, schema: { type: "array", items: "string", system: "labels" } },
    { fieldId: "summary", name: "Summary", required: true, schema: { type: "string", system: "summary" } },
  ];

  it("fills the create fields from the ticket, drops what the screen lacks, and builds the echo memory", () => {
    const r = buildMappedCreateFields({
      mappings: MAPS,
      projectKey: "ENG",
      defs: DEFS,
      customValues: { "fd-browser": "Safari", "fd-sev": "High", "fd-vip": true },
      createFields,
      at: "2026-09-20T10:00:00Z",
    });
    expect(r.fields).toEqual({ customfield_1: "Safari", customfield_4: { id: "11" } });
    expect(r.filled.sort()).toEqual(["customfield_1", "customfield_4"]);
    expect(r.skipped).toContainEqual({ mappingId: "m-vip", reason: "not_on_screen" });
    expect(r.preview.map((p) => [p.label, p.jiraName, p.display])).toEqual([
      ["Browser", "Browser", "Safari"],
      ["Severity", "Severity", "High"],
    ]);
    expect(r.state["m-browser"]).toMatchObject({ vircle: hashNorm("Safari"), jira: hashNorm("Safari") });
  });

  it("a checkbox mapped to labels adds its label; an unticked one adds nothing; from-Jira-only mappings are not sent", () => {
    const maps = [mapping({ id: "m-l", ticket_field_id: "fd-vip", jira_field_id: "labels", jira_kind: "labels", direction: "to_jira" }), mapping({ direction: "from_jira" })];
    const on = buildMappedCreateFields({ mappings: maps, projectKey: "ENG", defs: DEFS, customValues: { "fd-vip": true, "fd-browser": "x" }, createFields, at: "t" });
    expect(on.extraLabels).toEqual(["vip"]);
    expect(on.fields).toEqual({});
    const off = buildMappedCreateFields({ mappings: maps, projectKey: "ENG", defs: DEFS, customValues: {}, createFields, at: "t" });
    expect(off.extraLabels).toEqual([]);
  });

  it("previewCreate shows the mapped fields, and a required field a mapping fills is not asked for again", async () => {
    const { store, ctx } = setup({ custom: { "fd-browser": "Safari", "fd-sev": "High" }, script: { listCreateFields: async () => ({ fields: createFields }) } });
    store.links.length = 0;
    const res = await previewCreate(ctx, { ticketId: "t-1", choices: { projectKey: "ENG", issueTypeId: "10004" }, customer: null });
    expect(res.plan.preview.mappedFields).toEqual([
      { label: "Browser", jiraName: "Browser", display: "Safari" },
      { label: "Severity", jiraName: "Severity", display: "High" },
    ]);
    expect(res.plan.fields).toMatchObject({ customfield_1: "Safari", customfield_4: { id: "11" } });
    expect(res.required.ask.map((a) => a.field.name)).toEqual([]);
  });

  it("createIssueFromTicket sends the mapped fields and stores the echo memory on the new link", async () => {
    const created: Record<string, unknown>[] = [];
    const { store, ctx } = setup({
      custom: { "fd-browser": "Safari", "fd-sev": "High" },
      script: {
        listCreateFields: async () => ({ fields: createFields }),
        createIssue: async (f) => {
          created.push(f);
          return { id: "10099", key: "ENG-99" };
        },
        getIssue: async () => issue({ id: "10099", key: "ENG-99" }),
      },
    });
    store.links.length = 0;
    const link = await createIssueFromTicket(ctx, { ticketId: "t-1", choices: { projectKey: "ENG", issueTypeId: "10004" }, customer: null, userId: "user-agent" });
    expect(created[0]).toMatchObject({ customfield_1: "Safari", customfield_4: { id: "11" } });
    expect(link.field_state?.["m-browser"]?.vircle).toBe(hashNorm("Safari"));
    expect(store.links.find((l) => l.id === link.id)?.field_state?.["m-sev"]).toBeTruthy();
  });
});
