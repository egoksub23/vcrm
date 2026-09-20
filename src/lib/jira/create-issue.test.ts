import { describe, expect, it } from "vitest";

import { adfToPlainText } from "./adf";
import type { CreateField } from "./client";
import {
  analyseRequired,
  buildCreatePlan,
  buildSummary,
  coerceFieldValue,
  fieldKind,
  parseIssueRef,
  remoteLinkGlobalId,
  sanitizeLabel,
} from "./create-issue";
import { buildSearchJql, jqlString } from "./search";
import { normalizeSettings } from "./settings";

const ticket = { ticket_number: 12, subject: "Login fails on Safari", description: "Customer cannot sign in.\n\n- step 1\n- step 2", category: "feature_request", priority: "urgent" as const };
const customer = { name: "Grace Hopper", email: "grace@example.com" };

describe("what gets sent to Jira", () => {
  const plan = (settings = {}, over: Partial<Parameters<typeof buildCreatePlan>[0]> = {}) =>
    buildCreatePlan({
      ticket,
      customer,
      settings: normalizeSettings(settings),
      choices: { projectKey: "ENG", issueTypeId: "10004", issueTypeName: "Bug" },
      ticketKey: "VIR-12",
      ticketUrl: "https://crm.example.com/tickets/abc",
      descriptionToPlain: (d) => adfToPlainText(d),
      ...over,
    });

  it("pre-fills project, type, summary, description with a link back, and the vircle + category labels", () => {
    const p = plan();
    expect(p.fields).toMatchObject({ project: { key: "ENG" }, issuetype: { id: "10004" }, summary: "Login fails on Safari" });
    expect(p.fields.labels).toEqual(["vircle", "feature_request"]);
    expect(p.preview.descriptionText).toContain("Customer cannot sign in.");
    expect(p.preview.descriptionText).toContain("Vircle ticket VIR-12");
    expect(JSON.stringify(p.fields.description)).toContain("https://crm.example.com/tickets/abc");
  });

  it("EXCLUDES the customer's name and email by default, in the request AND the preview", () => {
    const p = plan();
    const everything = JSON.stringify(p.fields) + JSON.stringify(p.preview);
    expect(everything).not.toContain("Grace");
    expect(everything).not.toContain("grace@example.com");
    expect(p.preview.includesCustomer).toBe(false);
  });

  it("includes them only when an admin turned that on, and says so in the preview", () => {
    const p = plan({ privacy: { include_customer: true } });
    expect(p.preview.descriptionText).toContain("Customer: Grace Hopper <grace@example.com>");
    expect(p.preview.includesCustomer).toBe(true);
    // turned on but there is no customer: nothing to include
    expect(plan({ privacy: { include_customer: true } }, { customer: null }).preview.includesCustomer).toBe(false);
  });

  it("maps priority through the admin's map; an unmapped priority is left to Jira's default", () => {
    expect(plan({ mapping: { priority: { urgent: "Highest" } } }).fields.priority).toEqual({ name: "Highest" });
    expect(plan().fields.priority).toBeUndefined();
    expect(plan({ mapping: { priority: { urgent: "Highest" } } }, { choices: { projectKey: "ENG", issueTypeId: "1", priorityName: "Low" } }).fields.priority).toEqual({ name: "Low" });
  });

  it("drops fields the create screen does not have", () => {
    const screen: CreateField[] = [{ fieldId: "summary", name: "Summary", required: true }];
    const p = plan({ mapping: { priority: { urgent: "Highest" } } }, { createFields: screen });
    expect(p.fields.priority).toBeUndefined();
    expect(p.fields.labels).toBeUndefined();
  });

  it("truncates the summary to Jira's limit on one line", () => {
    expect(buildSummary("a\n  b   c")).toBe("a b c");
    const long = buildSummary("x".repeat(400));
    expect(long).toHaveLength(255);
    expect(long.endsWith("…")).toBe(true);
    expect(buildSummary("   ")).toBe("Untitled ticket");
  });

  it("labels are plain: no spaces, lower case, at most 10", () => {
    expect(sanitizeLabel(" Billing Issue! ")).toBe("billing-issue");
    expect(sanitizeLabel("???")).toBeNull();
    const p = plan({}, { choices: { projectKey: "ENG", issueTypeId: "1", extraLabels: Array.from({ length: 30 }, (_, i) => `l${i}`) } });
    expect((p.fields.labels as string[]).length).toBe(10);
  });

  it("carries an assignee only when chosen", () => {
    expect(plan().fields.assignee).toBeUndefined();
    expect(plan({}, { choices: { projectKey: "ENG", issueTypeId: "1", assigneeAccountId: "acct-1" } }).fields.assignee).toEqual({ accountId: "acct-1" });
  });

  it("uses a stable globalId so re-running updates the remote link instead of duplicating", () => {
    expect(remoteLinkGlobalId("a", "t")).toBe(remoteLinkGlobalId("a", "t"));
    expect(remoteLinkGlobalId("a", "t")).toBe("vircle:a:ticket:t");
    expect(remoteLinkGlobalId("a".repeat(300), "t").length).toBe(255);
  });
});

describe("required fields", () => {
  const f = (over: Partial<CreateField> & { fieldId: string }): CreateField => ({ name: over.fieldId, required: true, ...over });

  it("renders text, choices, users, labels, numbers and dates; the rest is 'Open in Jira instead'", () => {
    expect(fieldKind(f({ fieldId: "customfield_1", schema: { type: "string" } }))).toBe("text");
    expect(fieldKind(f({ fieldId: "customfield_2", schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea" } }))).toBe("textarea");
    expect(fieldKind(f({ fieldId: "customfield_3", schema: { type: "option" }, allowedValues: [{ id: "1", value: "A" }] }))).toBe("select");
    expect(fieldKind(f({ fieldId: "customfield_4", schema: { type: "array", items: "option" }, allowedValues: [{ id: "1", value: "A" }] }))).toBe("multiselect");
    expect(fieldKind(f({ fieldId: "customfield_5", schema: { type: "user" } }))).toBe("user");
    expect(fieldKind(f({ fieldId: "labels", schema: { type: "array", items: "string" } }))).toBe("labels");
    expect(fieldKind(f({ fieldId: "customfield_6", schema: { type: "number" } }))).toBe("number");
    expect(fieldKind(f({ fieldId: "customfield_7", schema: { type: "date" } }))).toBe("date");
    expect(fieldKind(f({ fieldId: "customfield_8", schema: { type: "array", items: "user" } }))).toBeNull();
    expect(fieldKind(f({ fieldId: "customfield_9", schema: { type: "any" } }))).toBeNull();
    expect(fieldKind(f({ fieldId: "customfield_10" }))).toBeNull();
  });

  it("asks only for what the request does not already fill", () => {
    const fields = [
      f({ fieldId: "summary" }),
      f({ fieldId: "description" }),
      f({ fieldId: "project" }),
      f({ fieldId: "issuetype" }),
      f({ fieldId: "reporter" }),
      f({ fieldId: "priority", schema: { type: "priority" }, allowedValues: [{ id: "1", name: "High" }] }),
      f({ fieldId: "customfield_11", name: "Environment", schema: { type: "option" }, allowedValues: [{ id: "1", value: "Prod" }] }),
      f({ fieldId: "customfield_12", name: "Optional", required: false, schema: { type: "string" } }),
      f({ fieldId: "customfield_13", name: "Has default", hasDefaultValue: true, schema: { type: "string" } }),
      f({ fieldId: "customfield_14", name: "Weird", schema: { type: "any" } }),
    ];
    const a = analyseRequired(fields, new Set(["summary", "priority"]));
    expect(a.ask.map((x) => x.field.fieldId)).toEqual(["customfield_11"]);
    expect(a.unsupported.map((x) => x.name)).toEqual(["Weird"]);
    // priority required and NOT mapped: the dialog must ask for it
    expect(analyseRequired(fields, new Set()).ask.map((x) => x.field.fieldId)).toContain("priority");
  });

  it("coerces the dialog's values to what Jira expects, and refuses ids that are not offered", () => {
    const select = f({ fieldId: "customfield_3", schema: { type: "option" }, allowedValues: [{ id: "10", value: "A" }, { id: "11", value: "B" }] });
    expect(coerceFieldValue(select, "select", "10")).toEqual({ id: "10" });
    expect(coerceFieldValue(select, "select", "999")).toBeUndefined();
    const multi = f({ fieldId: "customfield_4", schema: { type: "array", items: "option" }, allowedValues: [{ id: "10" }, { id: "11" }] });
    expect(coerceFieldValue(multi, "multiselect", ["10", "77", 5])).toEqual([{ id: "10" }]);
    expect(coerceFieldValue(multi, "multiselect", [])).toBeUndefined();
    expect(coerceFieldValue(f({ fieldId: "u" }), "user", "acct-1")).toEqual({ accountId: "acct-1" });
    expect(coerceFieldValue(f({ fieldId: "n" }), "number", "12.5")).toBe(12.5);
    expect(coerceFieldValue(f({ fieldId: "n" }), "number", "abc")).toBeUndefined();
    expect(coerceFieldValue(f({ fieldId: "d" }), "date", "2026-09-30")).toBe("2026-09-30");
    expect(coerceFieldValue(f({ fieldId: "d" }), "date", "30/09/2026")).toBeUndefined();
    expect(coerceFieldValue(f({ fieldId: "l" }), "labels", "Bug, Needs review")).toEqual(["bug", "needs"].concat(["review"]));
    expect((coerceFieldValue(f({ fieldId: "t" }), "textarea", "hello") as { type: string }).type).toBe("doc");
  });
});

describe("pasting a key or URL", () => {
  it("understands keys and Jira URLs", () => {
    expect(parseIssueRef("eng-482")).toEqual({ key: "ENG-482" });
    expect(parseIssueRef("  ENG-482  ")).toEqual({ key: "ENG-482" });
    expect(parseIssueRef("https://acme.atlassian.net/browse/ENG-482")).toEqual({ key: "ENG-482" });
    expect(parseIssueRef("https://acme.atlassian.net/jira/software/projects/ENG/boards/1?selectedIssue=ENG-482")).toEqual({ key: "ENG-482" });
  });
  it("refuses everything else", () => {
    for (const bad of ["", "login bug", "ENG-", "482", "https://acme.atlassian.net/", "ENG-482 and more", "javascript:alert(1)"]) {
      expect(parseIssueRef(bad), bad).toBeNull();
    }
  });
});

describe("the search box JQL", () => {
  it("escapes the user's text into a string literal and cannot add a clause", () => {
    expect(jqlString('say "hi" \\ there')).toBe('"say \\"hi\\" \\\\ there"');
    const jql = buildSearchJql('x" OR project = SECRET OR summary ~ "', []);
    expect(jql).not.toMatch(/project = SECRET/);
    expect(jql).toContain("text ~ ");
    expect(jql.endsWith("ORDER BY updated DESC")).toBe(true);
  });

  it("looks a key up exactly and scopes to the allowed projects", () => {
    const jql = buildSearchJql("ENG-482", ["ENG", "WEB"]);
    expect(jql).toContain('project in ("ENG", "WEB")');
    expect(jql).toContain('key = "ENG-482"');
  });

  it("strips Jira's wildcard characters and control characters", () => {
    expect(buildSearchJql("log*in? \n tab\t", [])).toContain('text ~ "log in tab"');
  });

  it("an empty box lists what changed recently", () => {
    expect(buildSearchJql("  ", [])).toBe("updated >= -30d ORDER BY updated DESC");
  });
});
