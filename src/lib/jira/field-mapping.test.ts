import { describe, expect, it } from "vitest";

import type { CreateField } from "./client";
import { decidePull, decidePush, hashNorm } from "./field-echo";
import {
  checkboxLabel,
  classifyJiraField,
  compatibleJiraKinds,
  fromJiraValue,
  isCompatible,
  mappingProblem,
  mappingsForProject,
  mergeWrites,
  normalizeVircleValue,
  parseCreateMeta,
  toJiraWrite,
  VIRCLE_FIELD_TYPES,
  type FieldMappingRow,
  type JiraFieldInfo,
  type JiraFieldKind,
  type VircleFieldDef,
  type VircleFieldType,
} from "./field-mapping";

const CF = "com.atlassian.jira.plugin.system.customfieldtypes:";

const fld = (over: Partial<CreateField> & { fieldId: string; name: string }): CreateField => ({ required: false, operations: ["set"], ...over });

const META: CreateField[] = [
  fld({ fieldId: "summary", name: "Summary", schema: { type: "string", system: "summary" } }),
  fld({ fieldId: "customfield_1", name: "Browser", schema: { type: "string", custom: `${CF}textfield` } }),
  fld({ fieldId: "customfield_2", name: "Steps", schema: { type: "string", custom: `${CF}textarea` } }),
  fld({ fieldId: "environment", name: "Environment", schema: { type: "string", system: "environment" } }),
  fld({ fieldId: "customfield_3", name: "Story points", schema: { type: "number", custom: `${CF}float` } }),
  fld({ fieldId: "duedate", name: "Due date", schema: { type: "date", system: "duedate" } }),
  fld({
    fieldId: "customfield_4",
    name: "Severity",
    schema: { type: "option", custom: `${CF}select` },
    allowedValues: [
      { id: "10", value: "Low" },
      { id: "11", value: "High" },
    ],
  }),
  fld({
    fieldId: "customfield_5",
    name: "VIP",
    schema: { type: "array", items: "option", custom: `${CF}multicheckboxes` },
    allowedValues: [{ id: "20", value: "Yes" }],
  }),
  fld({ fieldId: "labels", name: "Labels", schema: { type: "array", items: "string", system: "labels" }, operations: ["add", "set", "remove"] }),
  // not supported
  fld({ fieldId: "assignee", name: "Assignee", schema: { type: "user", system: "assignee" } }),
  fld({ fieldId: "customfield_6", name: "Reviewer", schema: { type: "user", custom: `${CF}userpicker` } }),
  fld({ fieldId: "fixVersions", name: "Fix versions", schema: { type: "array", items: "version", system: "fixVersions" } }),
  fld({ fieldId: "customfield_7", name: "Started at", schema: { type: "datetime", custom: `${CF}datetime` } }),
  fld({
    fieldId: "customfield_8",
    name: "Product",
    schema: { type: "option-with-child", custom: `${CF}cascadingselect` },
    allowedValues: [{ id: "1", value: "A" }],
  }),
  fld({ fieldId: "customfield_9", name: "Tags", schema: { type: "array", items: "option", custom: `${CF}multiselect` }, allowedValues: [{ id: "1", value: "x" }] }),
  fld({ fieldId: "customfield_10", name: "Locked", schema: { type: "string", custom: `${CF}textfield` }, operations: [] }),
  fld({ fieldId: "customfield_11", name: "Epic link", schema: { type: "any", custom: "com.pyxis.greenhopper.jira:gh-epic-link" } }),
];

const byId = (id: string) => classifyJiraField(META.find((f) => f.fieldId === id)!);

const def = (type: VircleFieldType, extra: Partial<VircleFieldDef> = {}): VircleFieldDef => ({
  id: "fd-1",
  label: "Field one",
  field_type: type,
  options: type === "dropdown" ? ["Low", "High"] : [],
  ...extra,
});

const mapping = (over: Partial<FieldMappingRow> = {}): FieldMappingRow => ({
  id: "m-1",
  account_id: "a",
  connection_id: "c",
  project_key: "ENG",
  ticket_field_id: "fd-1",
  jira_field_id: "customfield_1",
  jira_field_name: "Browser",
  jira_kind: "text",
  direction: "both",
  when_missing: "skip",
  default_value: null,
  config: null,
  ...over,
});

describe("classifyJiraField: which Jira fields are supported", () => {
  it("recognises the simple types", () => {
    const kinds: Record<string, JiraFieldKind> = {
      customfield_1: "text",
      customfield_2: "textarea",
      environment: "textarea",
      customfield_3: "number",
      duedate: "date",
      customfield_4: "select",
      customfield_5: "multicheckbox",
      labels: "labels",
    };
    for (const [id, kind] of Object.entries(kinds)) {
      const f = byId(id);
      expect({ id, kind: f.kind, supported: f.supported }).toEqual({ id, kind, supported: true });
    }
  });

  it("lists every other type as not supported, with a reason, and they cannot be mapped", () => {
    for (const id of ["assignee", "customfield_6", "fixVersions", "customfield_7", "customfield_8", "customfield_9", "customfield_10", "customfield_11", "summary"]) {
      const f = byId(id);
      expect(f.supported, id).toBe(false);
      expect(f.kind, id).toBe("unsupported");
      expect(f.reason, id).toBeTruthy();
      for (const t of VIRCLE_FIELD_TYPES) expect(mappingProblem({ field_type: t }, f), `${t} -> ${id}`).toBe("unsupported");
    }
    expect(byId("customfield_10").reason).toBe("readonly");
    expect(byId("summary").reason).toBe("handled");
    expect(byId("customfield_6").reason).toBe("type");
  });

  it("keeps the option list of a select as id + name (Jira calls the name 'value')", () => {
    expect(byId("customfield_4").options).toEqual([
      { id: "10", name: "Low" },
      { id: "11", name: "High" },
    ]);
  });

  it("a select with no options is not usable", () => {
    const f = classifyJiraField(fld({ fieldId: "customfield_20", name: "Empty", schema: { type: "option", custom: `${CF}select` }, allowedValues: [] }));
    expect(f.supported).toBe(false);
  });
});

describe("createmeta parsing", () => {
  it("classifies every field and lists the supported ones first, then by name", () => {
    const parsed = parseCreateMeta(META);
    expect(parsed).toHaveLength(META.length);
    const firstUnsupported = parsed.findIndex((f) => !f.supported);
    expect(parsed.slice(0, firstUnsupported).every((f) => f.supported)).toBe(true);
    expect(parsed.slice(firstUnsupported).every((f) => !f.supported)).toBe(true);
    const supportedNames = parsed.slice(0, firstUnsupported).map((f) => f.name);
    expect(supportedNames).toEqual([...supportedNames].sort((a, b) => a.localeCompare(b)));
  });

  it("uses the field key when Jira sends one and the field id otherwise", () => {
    expect(classifyJiraField({ fieldId: "customfield_1", key: "customfield_1", name: "x", required: false, schema: { type: "string", custom: `${CF}textfield` } }).id).toBe("customfield_1");
    expect(classifyJiraField({ fieldId: "customfield_9", name: "x", required: true }).required).toBe(true);
  });

  it("copes with a field that has no schema at all", () => {
    expect(classifyJiraField({ fieldId: "x", name: "x", required: false }).kind).toBe("unsupported");
  });
});

describe("the type compatibility matrix", () => {
  const expected: Record<VircleFieldType, JiraFieldKind[]> = {
    text: ["text", "textarea"],
    textarea: ["text", "textarea"],
    number: ["number"],
    date: ["date"],
    dropdown: ["select"],
    checkbox: ["multicheckbox", "labels"],
  };
  const all: JiraFieldKind[] = ["text", "textarea", "number", "date", "select", "multicheckbox", "labels", "unsupported"];

  for (const v of VIRCLE_FIELD_TYPES) {
    it(`${v} maps to exactly ${expected[v].join(", ")}`, () => {
      expect([...compatibleJiraKinds(v)].sort()).toEqual([...expected[v]].sort());
      for (const k of all) expect(isCompatible(v, k), `${v} <-> ${k}`).toBe(expected[v].includes(k));
    });
  }

  it("refuses a supported field of the wrong type", () => {
    expect(mappingProblem(def("number"), byId("customfield_1"))).toBe("incompatible");
    expect(mappingProblem(def("checkbox"), byId("customfield_1"))).toBe("incompatible");
    expect(mappingProblem(def("date"), byId("customfield_3"))).toBe("incompatible");
    expect(mappingProblem(def("text"), byId("customfield_1"))).toBeNull();
    expect(mappingProblem(def("checkbox"), byId("labels"))).toBeNull();
  });
});

describe("Vircle -> Jira conversion", () => {
  const w = (d: VircleFieldDef, info: JiraFieldInfo, raw: unknown, m: Partial<FieldMappingRow> = {}) => toJiraWrite({ def: d, info, mapping: mapping(m), raw });

  it("text becomes one trimmed line, cut at 255", () => {
    const r = w(def("text"), byId("customfield_1"), "  Safari\n17  ");
    expect(r).toMatchObject({ kind: "write", lands: "Safari 17", write: { fields: { customfield_1: "Safari 17" } } });
    const long = w(def("text"), byId("customfield_1"), "x".repeat(400));
    expect(long.kind === "write" && (long.write.fields!.customfield_1 as string).length).toBe(255);
  });

  it("text and textarea go into a paragraph field as ADF (text only)", () => {
    const r = w(def("textarea"), byId("customfield_2"), "line one\n\nline two");
    expect(r.kind).toBe("write");
    if (r.kind === "write") {
      const doc = r.write.fields!.customfield_2 as { type: string; version: number; content: { type: string }[] };
      expect(doc.type).toBe("doc");
      expect(doc.version).toBe(1);
      expect(doc.content.every((n) => n.type === "paragraph")).toBe(true);
      expect(r.lands).toBe("line one\n\nline two");
    }
  });

  it("number, date", () => {
    expect(w(def("number"), byId("customfield_3"), "42.5")).toMatchObject({ kind: "write", lands: 42.5 });
    expect(w(def("date"), byId("duedate"), "2026-10-01")).toMatchObject({ kind: "write", write: { fields: { duedate: "2026-10-01" } } });
    expect(w(def("date"), byId("duedate"), "tomorrow")).toEqual({ kind: "skip", reason: "missing" });
  });

  it("dropdown: the option is matched by name, ignoring case; an unknown name is skipped", () => {
    expect(w(def("dropdown"), byId("customfield_4"), "High")).toMatchObject({ kind: "write", write: { fields: { customfield_4: { id: "11" } } }, lands: "High" });
    const d = def("dropdown", { options: ["Low", "HIGH", "Critical"] });
    expect(w(d, byId("customfield_4"), "HIGH")).toMatchObject({ kind: "write", write: { fields: { customfield_4: { id: "11" } } } });
    expect(w(d, byId("customfield_4"), "Critical")).toEqual({ kind: "skip", reason: "no_option" });
  });

  it("checkbox -> multi checkbox: ticked picks the option (preferring Yes), unticked clears", () => {
    const yes = w(def("checkbox"), byId("customfield_5"), true);
    expect(yes).toMatchObject({ kind: "write", write: { fields: { customfield_5: [{ id: "20" }] } }, lands: true });
    expect(w(def("checkbox"), byId("customfield_5"), false, { when_missing: "clear" })).toMatchObject({ kind: "write", write: { fields: { customfield_5: [] } }, lands: null });
  });

  it("checkbox -> labels adds or removes ONE label and never touches the others", () => {
    const on = w(def("checkbox", { label: "Urgent for VIP" }), byId("labels"), true);
    expect(on).toMatchObject({ kind: "write", write: { update: { labels: [{ add: "urgent-for-vip" }] } } });
    expect(on.kind === "write" && on.write.fields).toBeUndefined();
    const off = w(def("checkbox", { label: "Urgent for VIP" }), byId("labels"), undefined, { when_missing: "clear" });
    expect(off).toMatchObject({ kind: "write", write: { update: { labels: [{ remove: "urgent-for-vip" }] } } });
    expect(checkboxLabel({ label: "Urgent for VIP" }, { label: "Big Deal!" })).toBe("big-deal");
  });

  it("when the value is missing: skip, clear or the default", () => {
    expect(w(def("text"), byId("customfield_1"), undefined, { when_missing: "skip" })).toEqual({ kind: "skip", reason: "missing" });
    expect(w(def("text"), byId("customfield_1"), "", { when_missing: "clear" })).toMatchObject({ kind: "write", write: { fields: { customfield_1: null } }, lands: null });
    expect(w(def("text"), byId("customfield_1"), null, { when_missing: "default", default_value: "n/a" })).toMatchObject({ kind: "write", lands: "n/a" });
    expect(w(def("text"), byId("customfield_1"), null, { when_missing: "default", default_value: null })).toEqual({ kind: "skip", reason: "missing" });
    expect(w(def("number"), byId("customfield_3"), null, { when_missing: "clear" })).toMatchObject({ kind: "write", write: { fields: { customfield_3: null } } });
  });

  it("never writes an unsupported or incompatible pairing", () => {
    expect(w(def("text"), byId("customfield_6"), "x")).toEqual({ kind: "skip", reason: "unsupported" });
    expect(w(def("number"), byId("customfield_1"), 3)).toEqual({ kind: "skip", reason: "unsupported" });
  });

  it("merges several writes into one PUT body", () => {
    expect(
      mergeWrites([
        { fields: { a: 1 } },
        { fields: { b: 2 } },
        { update: { labels: [{ add: "x" }] } },
        { update: { labels: [{ remove: "y" }] } },
      ]),
    ).toEqual({ fields: { a: 1, b: 2 }, update: { labels: [{ add: "x" }, { remove: "y" }] } });
  });
});

describe("Jira -> Vircle conversion", () => {
  const r = (d: VircleFieldDef, info: JiraFieldInfo, raw: unknown) => fromJiraValue({ def: d, info, raw, mapping: mapping() });

  it("reads text, ADF, numbers, dates", () => {
    expect(r(def("text"), byId("customfield_1"), "Safari  17")).toEqual({ kind: "value", norm: "Safari 17" });
    expect(r(def("textarea"), byId("customfield_2"), { version: 1, type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] })).toEqual({ kind: "value", norm: "hello" });
    expect(r(def("number"), byId("customfield_3"), 8)).toEqual({ kind: "value", norm: 8 });
    expect(r(def("date"), byId("duedate"), "2026-10-01")).toEqual({ kind: "value", norm: "2026-10-01" });
    expect(r(def("text"), byId("customfield_1"), null)).toEqual({ kind: "value", norm: null });
  });

  it("dropdown: by option name; a choice the Vircle dropdown lacks is skipped, never invented", () => {
    expect(r(def("dropdown"), byId("customfield_4"), { id: "11", value: "high" })).toEqual({ kind: "value", norm: "High" });
    expect(r(def("dropdown"), byId("customfield_4"), { id: "99", value: "Blocker" })).toEqual({ kind: "skip", reason: "no_option" });
  });

  it("checkbox from a multi checkbox and from labels", () => {
    expect(r(def("checkbox"), byId("customfield_5"), [{ id: "20", value: "Yes" }])).toEqual({ kind: "value", norm: true });
    expect(r(def("checkbox"), byId("customfield_5"), [])).toEqual({ kind: "value", norm: null });
    const d = def("checkbox", { label: "Urgent for VIP" });
    expect(fromJiraValue({ def: d, info: byId("labels"), raw: ["bug", "urgent-for-vip"], mapping: mapping() })).toEqual({ kind: "value", norm: true });
    expect(fromJiraValue({ def: d, info: byId("labels"), raw: ["bug"], mapping: mapping() })).toEqual({ kind: "value", norm: null });
  });

  it("normalises ticket values into the same domain", () => {
    expect(normalizeVircleValue(def("checkbox"), true)).toBe(true);
    expect(normalizeVircleValue(def("checkbox"), false)).toBeNull();
    expect(normalizeVircleValue(def("number"), "12")).toBe(12);
    expect(normalizeVircleValue(def("number"), "abc")).toBeNull();
    expect(normalizeVircleValue(def("dropdown"), "Nope")).toBeNull();
    expect(normalizeVircleValue(def("text"), "  x ")).toBe("x");
  });
});

describe("echo decisions", () => {
  it("push: an unchanged value is not pushed again", () => {
    expect(decidePush(undefined, "a")).toBe("push");
    expect(decidePush({ vircle: hashNorm("a") }, "a")).toBe("unchanged");
    expect(decidePush({ vircle: hashNorm("a") }, "b")).toBe("push");
    expect(decidePush({ vircle: hashNorm(null) }, null)).toBe("unchanged");
  });

  it("pull: first sight is recorded, an unchanged value is ignored, our own write is an echo, a real change applies", () => {
    expect(decidePull(undefined, "a")).toEqual({ kind: "seed" });
    expect(decidePull({}, "a")).toEqual({ kind: "seed" });
    expect(decidePull({ jira: hashNorm("a"), vircle: hashNorm("a") }, "a")).toEqual({ kind: "unchanged" });
    expect(decidePull({ jira: hashNorm("old"), vircle: hashNorm("mine") }, "mine")).toEqual({ kind: "echo" });
    expect(decidePull({ jira: hashNorm("old"), vircle: hashNorm("mine") }, "theirs")).toEqual({ kind: "apply" });
    expect(decidePull({ jira: hashNorm("x"), vircle: hashNorm("x") }, null)).toEqual({ kind: "apply" });
  });
});

describe("mappingsForProject", () => {
  it("a project mapping beats a '*' one for the same ticket field; other projects see only '*'", () => {
    const rows = [
      mapping({ id: "all", project_key: "*", jira_field_id: "customfield_1" }),
      mapping({ id: "eng", project_key: "ENG", jira_field_id: "customfield_9" }),
      mapping({ id: "other-field", project_key: "*", ticket_field_id: "fd-2", jira_field_id: "customfield_3" }),
    ];
    expect(mappingsForProject(rows, "ENG").map((m) => m.id).sort()).toEqual(["eng", "other-field"]);
    expect(mappingsForProject(rows, "ops").map((m) => m.id).sort()).toEqual(["all", "other-field"]);
    expect(mappingsForProject(rows, null).map((m) => m.id).sort()).toEqual(["all", "other-field"]);
  });
});
