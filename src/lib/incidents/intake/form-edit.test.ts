import { describe, expect, it } from "vitest";

import { CCA_FORM, type FormSchema } from "./form-schema";
import {
  addField,
  addOption,
  addStep,
  conditionCandidates,
  diffSchemas,
  moveField,
  moveStep,
  removeField,
  removeOption,
  removeStep,
  setCondition,
  slugKey,
  updateField,
  updateOption,
  updateStep,
  validateSchema,
} from "./form-edit";

const ctx = { categoryCodes: ["CCA", "NMS", "PRD", "OTH"] };
const keysIn = (s: FormSchema, step: string) => s.steps.find((x) => x.key === step)!.fields.map((f) => f.key);

describe("the built-in form", () => {
  it("passes the publish check against the School template", () => {
    expect(validateSchema(CCA_FORM, ctx)).toEqual([]);
  });
});

describe("editing", () => {
  it("adds a field of any type where it is dropped, with starting words, without touching the original", () => {
    const { schema, key } = addField(CCA_FORM, "what", "yesno", 1);
    expect(keysIn(schema, "what")).toEqual(["kind", key, "what"]);
    expect(schema.steps[1].fields[1]).toMatchObject({ type: "yesno", label: { en: "Yes or no?" } });
    expect(keysIn(CCA_FORM, "what")).toEqual(["kind", "what"]);
  });
  it("gives a new field a key that is not taken, and starts a choice with two options", () => {
    const a = addField(CCA_FORM, "what", "choice");
    const b = addField(a.schema, "what", "choice");
    expect(new Set([a.key, b.key]).size).toBe(2);
    expect(b.schema.steps[1].fields.at(-1)?.options).toHaveLength(2);
  });
  it("moves a field between steps and within a step, landing where it was dropped", () => {
    const toWho = moveField(CCA_FORM, "what", "who", 0);
    expect(keysIn(toWho, "who")).toEqual(["what", "involved"]);
    expect(keysIn(toWho, "what")).toEqual(["kind"]);
    const down = moveField(CCA_FORM, "kind", "what", 2); // dropped after "what"
    expect(keysIn(down, "what")).toEqual(["what", "kind"]);
    const up = moveField(CCA_FORM, "what", "what", 0);
    expect(keysIn(up, "what")).toEqual(["what", "kind"]);
    expect(moveField(CCA_FORM, "nope", "what", 0)).toBe(CCA_FORM);
  });
  it("removes a field, and stops anything that depended on it being hidden forever", () => {
    const out = removeField(CCA_FORM, "kind");
    expect(keysIn(out, "what")).toEqual(["what"]);
    expect(out.steps[2].fields.find((f) => f.key === "body_part")?.showIf).toBeUndefined();
  });
  it("renames fields and steps, reorders steps, and folds a deleted step into its neighbour", () => {
    expect(updateField(CCA_FORM, "what", { label: { en: "Describe it" }, required: false }).steps[1].fields[1]).toMatchObject({ label: { en: "Describe it" }, required: false });
    expect(updateStep(CCA_FORM, "how", { en: "Seriousness" }).steps[2].title).toEqual({ en: "Seriousness" });
    expect(moveStep(CCA_FORM, "how", 0).steps.map((s) => s.key)).toEqual(["how", "who", "what"]);
    const merged = removeStep(CCA_FORM, "how");
    expect(merged.steps.map((s) => s.key)).toEqual(["who", "what"]);
    expect(keysIn(merged, "what")).toEqual(["kind", "what", "severity", "body_part", "head_injury", "photo"]);
    const one: FormSchema = { ...CCA_FORM, steps: [CCA_FORM.steps[0]] };
    expect(removeStep(one, "who")).toBe(one);
    expect(addStep(CCA_FORM).schema.steps).toHaveLength(4);
  });
  it("adds, changes and removes options, and clears a condition that pointed at a removed option", () => {
    const more = addOption(CCA_FORM, "kind");
    expect(more.steps[1].fields[0].options).toHaveLength(5);
    const renamed = updateOption(CCA_FORM, "kind", "damage", { label: { en: "Broken equipment" } });
    expect(renamed.steps[1].fields[0].options?.find((o) => o.value === "damage")?.label.en).toBe("Broken equipment");
    const without = removeOption(CCA_FORM, "kind", "injury");
    expect(without.steps[1].fields[0].options?.map((o) => o.value)).toEqual(["near_miss", "damage", "other"]);
    expect(without.steps[2].fields.find((f) => f.key === "body_part")?.showIf).toBeUndefined();
    expect(addOption(CCA_FORM, "what")).toBe(CCA_FORM);
  });
  it("offers only earlier choices as things a field can depend on", () => {
    expect(conditionCandidates(CCA_FORM, "body_part").map((f) => f.key)).toEqual(["kind", "severity"]);
    expect(conditionCandidates(CCA_FORM, "involved")).toEqual([]);
    expect(setCondition(CCA_FORM, "photo", { field: "kind", equals: "damage" }).steps[2].fields.at(-1)?.showIf).toEqual({ field: "kind", equals: "damage" });
    expect(setCondition(CCA_FORM, "body_part", undefined).steps[2].fields.find((f) => f.key === "body_part")?.showIf).toBeUndefined();
  });
  it("makes a readable key from a label", () => {
    expect(slugKey("Where did it happen?", "x")).toBe("where_did_it_happen");
    expect(slugKey("3rd party", "fallback")).toBe("fallback");
  });
});

describe("the publish check", () => {
  const problems = (s: unknown, c = ctx) => validateSchema(s, c);

  it("rejects something that is not a form, a wrong version and a form with no steps", () => {
    expect(problems(null)).toEqual(["The form is empty."]);
    expect(problems({ version: 2, steps: [] })).toEqual(["This form format is not supported.", "Add at least one step."]);
  });
  it("needs a Who-was-involved field, and only one", () => {
    const noWho = removeField(CCA_FORM, "involved");
    expect(problems(noWho)).toContain('Add a "Who was involved?" field.');
    expect(problems(noWho)).toContain('Step 1: it is empty. Add a field or delete the step.');
    const two = addField(CCA_FORM, "who", "involved").schema;
    expect(problems(two)).toContain('Only one "Who was involved?" field is allowed.');
  });
  it("needs a required, always-shown choice that files the report under a category", () => {
    const none = updateField(CCA_FORM, "kind", { options: [{ value: "a", label: { en: "A" } }, { value: "b", label: { en: "B" } }] });
    expect(problems(none)).toContain("Add a choice whose options say what kind of incident it is (each option files under a category).");
    expect(problems(updateField(CCA_FORM, "kind", { required: false }))).toEqual(['"What kind of incident was it?": the question about the kind of incident must be required.']);
    expect(problems(setCondition(CCA_FORM, "kind", { field: "involved", equals: "x" }))[0]).toMatch(/must always be shown|can only depend on a choice|does not come before/);
  });
  it("checks every category and flag against what the school and Halo have", () => {
    const badCat = updateOption(CCA_FORM, "kind", "damage", { effects: { category: "ZZZ" } });
    expect(problems(badCat)).toEqual([expect.stringContaining('has no category "ZZZ"')]);
    const badFlag = updateOption(CCA_FORM, "kind", "damage", { effects: { category: "PRD", flags: ["telepathy"] } });
    expect(problems(badFlag)).toEqual([expect.stringContaining('"telepathy" is not a flag')]);
    const badBand = updateOption(CCA_FORM, "severity", "minor", { effects: { band: "catastrophic" as never } });
    expect(problems(badBand)).toEqual([expect.stringContaining("unknown severity band")]);
  });
  it("needs wording, two options per choice, and a real key on everything", () => {
    expect(problems(updateField(CCA_FORM, "what", { label: { en: " " } }))[0]).toMatch(/give the question some words/);
    expect(problems(updateField(CCA_FORM, "severity", { options: [{ value: "x", label: { en: "X" } }] }))[0]).toMatch(/at least two options/);
    const dupe = JSON.parse(JSON.stringify(CCA_FORM)) as FormSchema;
    dupe.steps[1].fields[1].key = "kind";
    expect(problems(dupe).join(" ")).toMatch(/key is missing or repeated/);
  });
  it("lets a field depend only on an earlier choice that has that option", () => {
    const later = setCondition(CCA_FORM, "kind", { field: "severity", equals: "minor" });
    expect(problems(later).join(" ")).toMatch(/does not come before it|must always be shown/);
    const gone = setCondition(CCA_FORM, "photo", { field: "kind", equals: "volcano" });
    expect(problems(gone)).toEqual([expect.stringContaining("an option that no longer exists")]);
    const notChoice = setCondition(CCA_FORM, "photo", { field: "involved", equals: "x" });
    expect(problems(notChoice)).toEqual([expect.stringContaining("can only depend on a choice")]);
  });
  it("limits the size of a form", () => {
    let big = CCA_FORM;
    for (let i = 0; i < 35; i++) big = addField(big, "how", "text").schema;
    expect(problems(big).join(" ")).toMatch(/at most 40 fields/);
    let wide = CCA_FORM;
    for (let i = 0; i < 4; i++) wide = addStep(wide).schema;
    expect(problems(wide).join(" ")).toMatch(/at most 6 steps/);
  });
  it("refuses options on a field that is not a choice and effects on a field that is not yes or no", () => {
    expect(problems(updateField(CCA_FORM, "what", { options: [{ value: "a", label: { en: "A" } }] }))[0]).toMatch(/only a choice has options/);
    expect(problems(updateField(CCA_FORM, "what", { ifYes: { flags: ["injury"] } }))[0]).toMatch(/only a yes or no question/);
  });
});

describe("comparing versions", () => {
  it("says what was added, removed, reworded and moved", () => {
    const edited = moveField(updateField(removeField(addField(CCA_FORM, "how", "text").schema, "photo"), "what", { label: { en: "Describe it" } }), "head_injury", "what", 0);
    const d = diffSchemas(CCA_FORM, edited);
    expect(d.added).toEqual(["Short answer"]);
    expect(d.removed).toEqual(["Add a photo (optional)"]);
    expect(d.changed).toEqual(["Describe it"]);
    expect(d.moved).toEqual(["Did the student hit their head, or seem dazed or confused?"]);
    expect(d.same).toBe(false);
  });
  it("is 'same' for identical forms and notices a renamed step", () => {
    expect(diffSchemas(CCA_FORM, JSON.parse(JSON.stringify(CCA_FORM))).same).toBe(true);
    expect(diffSchemas(CCA_FORM, updateStep(CCA_FORM, "how", { en: "Seriousness" })).same).toBe(false);
  });
});
