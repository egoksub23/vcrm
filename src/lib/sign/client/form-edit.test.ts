import { describe, expect, it } from "vitest";

import type { Rule } from "../forms/types";
import { validateForm } from "../forms/validate";
import {
  addField,
  addPart,
  contactCapable,
  deleteField,
  deletePart,
  duplicateField,
  emptyForm,
  fieldsInOrder,
  fieldsInPart,
  moveField,
  movePart,
  moveItem,
  partsOfRole,
  pruneRule,
  renameField,
  renamePartKey,
  retypeField,
  rulesUsing,
  ruleTargets,
  scrubRules,
  stepField,
  stepPart,
  updateField,
} from "./form-edit";
import { L, placements, roles, sampleForm, seeds } from "./form-fixtures";
import { takenDataKeys } from "./form-keys";
import { canUndoHist, initHist, pushHist, redoHist, undoHist } from "./form-history";

const keys = (fs: { key: string }[]) => fs.map((f) => f.key);

describe("moveItem", () => {
  it("moves, clamps and returns the same array when nothing moves", () => {
    expect(moveItem([1, 2, 3, 4], 0, 2)).toEqual([2, 3, 1, 4]);
    expect(moveItem([1, 2, 3, 4], 3, -5)).toEqual([4, 1, 2, 3]);
    const a = [1, 2, 3];
    expect(moveItem(a, 1, 1)).toBe(a);
    expect(moveItem(a, 7, 0)).toBe(a);
  });
});

describe("parts", () => {
  it("adds a part with a key from its title and keeps keys unique", () => {
    const one = addPart(emptyForm(), { title: "Company and tax", role: "merchant" });
    expect(one?.key).toBe("company_and_tax");
    const two = addPart(one!.form, { title: "Company and tax", role: "merchant" });
    expect(two?.key).toBe("company_and_tax_2");
    expect(two?.form.parts).toHaveLength(2);
  });

  it("stops at the maximum number of parts", () => {
    let form = emptyForm();
    for (let i = 0; i < 20; i++) form = addPart(form, { title: `Part ${i}`, role: "merchant" })!.form;
    expect(addPart(form, { title: "One more", role: "merchant" })).toBeNull();
  });

  it("reorders by position and by one step, and does nothing past the ends", () => {
    const form = sampleForm();
    expect(keys(movePart(form, "bank", 0).parts)).toEqual(["bank", "company", "tax"]);
    expect(keys(stepPart(form, "company", 1).parts)).toEqual(["tax", "company", "bank"]);
    expect(stepPart(form, "company", -1)).toBe(form);
    expect(stepPart(form, "bank", 1)).toBe(form);
    expect(movePart(form, "nope", 0)).toBe(form);
    // the fields are untouched by reordering parts
    expect(movePart(form, "bank", 0).fields).toBe(form.fields);
  });

  it("deleting a part removes its fields and every rule that named them", () => {
    // tax_pct is shown only when tax_type is SST: delete the tax part and nothing may point at it
    const form = sampleForm();
    form.fields.push({ key: "extra", type: "text", part: "bank", label: L("Extra"), required: false, visibleIf: { op: "eq", field: "tax_type", value: "sst" }, requiredIf: { op: "and", rules: [{ op: "notEmpty", field: "tax_type" }, { op: "notEmpty", field: "legal_name" }] } });
    form.parts[0] = { ...form.parts[0], visibleIf: { op: "notEmpty", field: "msic" } };
    const r = deletePart(form, "tax");
    expect(r.removedFields).toEqual(["tax_type", "tax_pct", "msic"]);
    expect(r.form.parts.map((p) => p.key)).toEqual(["company", "bank"]);
    expect(r.form.fields.every((f) => f.part !== "tax")).toBe(true);
    const extra = r.form.fields.find((f) => f.key === "extra")!;
    expect(extra.visibleIf).toBeUndefined();
    expect(extra.requiredIf).toEqual({ op: "notEmpty", field: "legal_name" });
    expect(r.form.parts[0].visibleIf).toBeUndefined();
    expect(r.ruleChanges).toEqual(
      expect.arrayContaining([
        { field: "extra", which: "visibleIf", result: "removed" },
        { field: "extra", which: "requiredIf", result: "trimmed" },
        { part: "company", which: "visibleIf", result: "removed" },
      ]),
    );
    // and the result is a sound form
    expect(validateForm(r.form, roles, [])).toEqual([]);
  });

  it("renames a part key and moves its fields along", () => {
    const r = renamePartKey(sampleForm(), "tax", "tax_details");
    expect(r.parts.map((p) => p.key)).toContain("tax_details");
    expect(fieldsInPart(r, "tax_details")).toHaveLength(3);
    expect(renamePartKey(sampleForm(), "tax", "bank").parts.map((p) => p.key)).toEqual(["company", "tax", "bank"]);
  });

  it("lists the parts a role holds", () => {
    expect(partsOfRole(sampleForm(), "merchant").map((p) => p.key)).toEqual(["company", "tax"]);
    expect(partsOfRole(sampleForm(), "nobody")).toEqual([]);
  });
});

describe("data fields", () => {
  it("adds a valid field of every type at the end of its part", () => {
    for (const type of ["text", "multiline", "number", "email", "phone", "choice", "multichoice", "yesno", "date", "list", "file", "image", "acknowledge"] as const) {
      const form = sampleForm();
      const r = addField(form, { part: "tax", type, seeds, taken: takenDataKeys(form, placements) })!;
      expect(r.key).toMatch(/^new_field/);
      const added = r.form.fields.find((f) => f.key === r.key)!;
      expect(added.type).toBe(type);
      expect(fieldsInPart(r.form, "tax").at(-1)).toBe(added);
      expect(validateForm(r.form, roles, placements)).toEqual([]);
    }
  });

  it("gives every new field its own key, also against the placements", () => {
    let form = sampleForm();
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const r = addField(form, { part: "company", type: "text", seeds, taken: takenDataKeys(form, placements) })!;
      form = r.form;
      expect(seen.has(r.key)).toBe(false);
      seen.add(r.key);
    }
    expect(seen).toEqual(new Set(["new_field", "new_field_2", "new_field_3", "new_field_4", "new_field_5"]));
  });

  it("refuses a part that does not exist and stops at the maximum", () => {
    const form = sampleForm();
    expect(addField(form, { part: "nope", type: "text", seeds, taken: new Set() })).toBeNull();
    let big = addPart(emptyForm(), { title: "P", role: "merchant" })!.form;
    for (let i = 0; i < 200; i++) big = addField(big, { part: "p", type: "text", seeds, taken: new Set(), label: `F${i}` })!.form;
    expect(big.fields).toHaveLength(200);
    expect(addField(big, { part: "p", type: "text", seeds, taken: new Set() })).toBeNull();
  });

  it("reorders within a part and across parts without losing a field", () => {
    const form = sampleForm();
    expect(keys(fieldsInPart(stepField(form, "tax_pct", -1), "tax"))).toEqual(["tax_pct", "tax_type", "msic"]);
    expect(stepField(form, "tax_type", -1)).toBe(form);
    expect(stepField(form, "msic", 1)).toBe(form);

    const moved = moveField(form, "legal_name", { part: "tax", index: 1 });
    expect(keys(fieldsInPart(moved, "tax"))).toEqual(["tax_type", "legal_name", "tax_pct", "msic"]);
    expect(moved.fields.find((f) => f.key === "legal_name")!.part).toBe("tax");
    expect(moved.fields).toHaveLength(form.fields.length);
    expect(new Set(keys(moved.fields))).toEqual(new Set(keys(form.fields)));

    // into an empty part, and past the end
    const withEmpty = addPart(form, { title: "Empty", role: "merchant" })!;
    const intoEmpty = moveField(withEmpty.form, "msic", { part: withEmpty.key, index: 0 });
    expect(keys(fieldsInPart(intoEmpty, withEmpty.key))).toEqual(["msic"]);
    expect(keys(fieldsInPart(moveField(form, "tax_type", { part: "tax", index: 99 }), "tax")).at(-1)).toBe("tax_type");
    expect(moveField(form, "tax_type", { part: "tax", index: 0 })).toBe(form);
  });

  it("duplicates a field right after the original, with a new key and (copy) on every language", () => {
    const form = sampleForm();
    const r = duplicateField(form, "tax_pct", takenDataKeys(form, placements), seeds)!;
    expect(r.key).toBe("tax_percentage_copy");
    const copy = r.form.fields.find((f) => f.key === r.key)!;
    expect(copy.label).toEqual({ en: "Tax percentage (copy)", ms: "Peratusan cukai (copy)" });
    expect(copy.visibleIf).toEqual(form.fields.find((f) => f.key === "tax_pct")!.visibleIf);
    expect(r.form.fields.indexOf(copy)).toBe(r.form.fields.findIndex((f) => f.key === "tax_pct") + 1);
    expect(validateForm(r.form, roles, [])).toEqual([]);
  });

  it("deleting a field removes it from the rules that used it, and says so", () => {
    const r = deleteField(sampleForm(), "tax_type");
    expect(r.form.fields.some((f) => f.key === "tax_type")).toBe(false);
    const pct = r.form.fields.find((f) => f.key === "tax_pct")!;
    expect(pct.visibleIf).toBeUndefined();
    expect(pct.requiredIf).toBeUndefined();
    expect(r.ruleChanges).toHaveLength(2);
    expect(validateForm(r.form, roles, [])).toEqual([]);
    // an unknown field changes nothing
    const form = sampleForm();
    expect(deleteField(form, "nope").form).toBe(form);
  });

  it("renames a key and every rule that named it follows", () => {
    const r = renameField(sampleForm(), "tax_type", "gst_kind");
    expect(r.fields.find((f) => f.key === "tax_pct")!.visibleIf).toEqual({ op: "eq", field: "gst_kind", value: "sst" });
    expect(r.fields.find((f) => f.key === "tax_pct")!.requiredIf).toEqual({ op: "eq", field: "gst_kind", value: "sst" });
    expect(validateForm(r, roles, [])).toEqual([]);
    // never onto a key that is taken
    const form = sampleForm();
    expect(renameField(form, "tax_type", "tax_pct")).toBe(form);
    expect(renameField(form, "tax_type", "tax_type")).toBe(form);
  });

  it("finds the rules that use a field and the fields a rule may look at", () => {
    const form = sampleForm();
    expect(rulesUsing(form, new Set(["tax_type"]))).toEqual([
      { field: "tax_pct", which: "visibleIf", result: "trimmed" },
      { field: "tax_pct", which: "requiredIf", result: "trimmed" },
    ]);
    expect(rulesUsing(form, new Set(["msic"]))).toEqual([]);
    expect(ruleTargets(form, "tax_pct").map((f) => f.key)).not.toContain("tax_pct");
    expect(fieldsInOrder(form)).toHaveLength(form.fields.length);
  });

  it("prunes a rule tree to what is left, collapsing groups of one", () => {
    const rule: Rule = { op: "or", rules: [{ op: "eq", field: "a", value: "x" }, { op: "and", rules: [{ op: "empty", field: "b" }, { op: "empty", field: "c" }] }] };
    expect(pruneRule(rule, new Set(["a"]))).toEqual({ op: "and", rules: [{ op: "empty", field: "b" }, { op: "empty", field: "c" }] });
    expect(pruneRule(rule, new Set(["a", "b"]))).toEqual({ op: "empty", field: "c" });
    expect(pruneRule(rule, new Set(["a", "b", "c"]))).toBeUndefined();
    expect(pruneRule({ op: "not", rule: { op: "empty", field: "a" } }, new Set(["a"]))).toBeUndefined();
    expect(pruneRule(rule, new Set(["zzz"]))).toBe(rule);
    const form = sampleForm();
    expect(scrubRules(form, new Set(["zzz"])).form).toBe(form);
  });

  it("updates a field only when something changes", () => {
    const form = sampleForm();
    expect(updateField(form, "msic", (f) => f)).toBe(form);
    expect(updateField(form, "msic", { required: false }).fields.find((f) => f.key === "msic")!.required).toBe(false);
  });
});

describe("changing a field's type", () => {
  it("keeps what is shared and drops what belongs to the old type", () => {
    const form = sampleForm();
    const choice = form.fields.find((f) => f.key === "tax_type")!;
    const text = retypeField({ ...choice, help: L("Pick one"), contactField: "company", locked: true }, "text", seeds);
    expect(text.type).toBe("text");
    expect(text.options).toBeUndefined();
    expect(text.label).toEqual(choice.label);
    expect(text.help).toEqual(L("Pick one"));
    expect(text.contactField).toBe("company");
    expect(text.locked).toBe(true);

    const back = retypeField(choice, "multichoice", seeds);
    expect(back.options).toEqual(choice.options);

    const file = retypeField(choice, "file", seeds);
    expect(file.accept).toEqual(["pdf", "jpg", "png"]);
    expect(file.contactField).toBeUndefined();
    expect(retypeField(choice, "choice", seeds)).toBe(choice);
  });

  it("gives a type what it needs and keeps the form sound", () => {
    const form = sampleForm();
    for (const type of ["text", "multiline", "number", "email", "phone", "choice", "multichoice", "yesno", "date", "list", "file", "image", "acknowledge"] as const) {
      const f = form.fields.find((x) => x.key === "legal_name")!;
      const next = { ...form, fields: form.fields.map((x) => (x === f ? retypeField(f, type, seeds) : x)) };
      expect(validateForm(next, roles, [])).toEqual([]);
    }
    expect(contactCapable("file")).toBe(false);
    expect(contactCapable("text")).toBe(true);
  });
});

describe("undo history", () => {
  it("steps back and forward and merges typing into one step", () => {
    let h = initHist(1);
    h = pushHist(h, 2, { now: 0 });
    h = pushHist(h, 3, { coalesceKey: "label:a", now: 100 });
    h = pushHist(h, 4, { coalesceKey: "label:a", now: 200 });
    expect(h.past).toEqual([1, 2]);
    h = undoHist(h);
    expect(h.present).toBe(2);
    h = undoHist(h);
    expect(h.present).toBe(1);
    expect(canUndoHist(h)).toBe(false);
    h = redoHist(h);
    expect(h.present).toBe(2);
    // a new change drops the redo steps
    h = pushHist(h, 9, { now: 5000 });
    expect(h.future).toEqual([]);
    // the same value is not a step
    expect(pushHist(h, 9)).toBe(h);
  });
});
