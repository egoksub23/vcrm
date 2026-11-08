import { describe, expect, it } from "vitest";

import { CCA_FORM } from "@/lib/incidents/intake/form-schema";
import { canDelete, copyName, copySlug, formCategoryCodes, makeCode, parseCategory, ruleCategoryCodes, usageOf, whyNotDeletable } from "./categories";

const severities = ["critical", "high", "medium", "low"];

describe("what a school may send for a category", () => {
  it("needs a name for a new one, and takes the rest as options", () => {
    expect(parseCategory({ name: "  Lab   safety " }, { severities, isNew: true })).toEqual({ ok: true, value: { name: "Lab safety" } });
    expect(parseCategory({ description: "x" }, { severities, isNew: true })).toMatchObject({ ok: false, error: "Give the category a name." });
    expect(parseCategory({ name: "Fire", default_severity: "high", default_flags: ["injury", "injury", "outside_agency"], description: " Fire drill gone wrong " }, { severities, isNew: true })).toEqual({
      ok: true,
      value: { name: "Fire", defaultSeverity: "high", defaultFlags: ["injury", "outside_agency"], description: "Fire drill gone wrong" },
    });
  });
  it("lets a change leave anything out, but not everything", () => {
    expect(parseCategory({ hidden: true }, { severities, isNew: false })).toEqual({ ok: true, value: { hidden: true } });
    expect(parseCategory({ description: "" }, { severities, isNew: false })).toEqual({ ok: true, value: { description: null } });
    expect(parseCategory({ default_severity: null }, { severities, isNew: false })).toEqual({ ok: true, value: { defaultSeverity: null } });
    expect(parseCategory({}, { severities, isNew: false })).toMatchObject({ ok: false, error: "Nothing to change." });
  });
  it("refuses a blank or long name, an unknown severity or flag, and the wrong kinds of value", () => {
    expect(parseCategory(null, { severities, isNew: true })).toMatchObject({ ok: false });
    expect(parseCategory({ name: "   " }, { severities, isNew: false })).toMatchObject({ ok: false });
    expect(parseCategory({ name: "x".repeat(81) }, { severities, isNew: true })).toMatchObject({ ok: false });
    expect(parseCategory({ description: "x".repeat(301) }, { severities, isNew: false })).toMatchObject({ ok: false });
    expect(parseCategory({ description: 5 }, { severities, isNew: false })).toMatchObject({ ok: false });
    expect(parseCategory({ default_severity: "P1" }, { severities, isNew: false })).toMatchObject({ ok: false, error: "Choose one of the severity levels." });
    expect(parseCategory({ default_flags: ["telepathy"] }, { severities, isNew: false })).toMatchObject({ ok: false });
    expect(parseCategory({ default_flags: "injury" }, { severities, isNew: false })).toMatchObject({ ok: false });
    expect(parseCategory({ hidden: "yes" }, { severities, isNew: false })).toMatchObject({ ok: false });
  });
});

describe("the code for a new category", () => {
  it("uses the initials of a few words, or the first letters of one", () => {
    expect(makeCode("Lab safety incident", [])).toBe("LSI");
    expect(makeCode("Fire", [])).toBe("FIR");
    expect(makeCode("Bus & transport delay on a field trip today", [])).toBe("BTDO");
    expect(makeCode("  ", [])).toBe("CAT");
    expect(makeCode("X", [])).toBe("XCA");
  });
  it("is never one that is taken, whatever the case, and keeps counting up", () => {
    expect(makeCode("Fire", ["FIR"])).toBe("FIR2");
    expect(makeCode("Fire", ["fir", "FIR2"])).toBe("FIR3");
    expect(makeCode("Lab safety", new Set(["LS"]))).toBe("LS2");
  });
});

describe("the school's own copy", () => {
  it("is named as a copy, with a slug of its own per school", () => {
    expect(copyName("School Incident Management")).toBe("School Incident Management (our copy)");
    expect(copySlug("0b9c1f00-0000-4000-8000-000000000001")).toBe("school_incident_0b9c1f00000040008000000000000001");
    expect(copySlug("0b9c1f00-0000-4000-8000-000000000001")).not.toBe(copySlug("0b9c1f00-0000-4000-8000-000000000002"));
  });
});

describe("what uses a category", () => {
  it("reads the categories a rule names and a form files under", () => {
    expect(ruleCategoryCodes({ categories: ["CCA", "INJ"], min_severity: "high" })).toEqual(["CCA", "INJ"]);
    expect(ruleCategoryCodes({})).toEqual([]);
    expect(ruleCategoryCodes(null)).toEqual([]);
    expect(ruleCategoryCodes({ categories: [1, "SEC"] })).toEqual(["SEC"]);
    expect(formCategoryCodes(CCA_FORM)).toContain("CCA");
    expect(formCategoryCodes(null)).toEqual([]);
  });
  it("counts incidents, rules and forms, and allows a delete only when all are zero", () => {
    const data = { incidentTypes: ["CCA", "CCA", "SEC"], ruleCategories: [["CCA"], ["SEC", "FIR"], []], formCategories: [["CCA", "NMS"]] };
    expect(usageOf("CCA", data)).toEqual({ incidents: 2, rules: 1, forms: 1 });
    expect(usageOf("FIR", data)).toEqual({ incidents: 0, rules: 1, forms: 0 });
    expect(usageOf("ZZZ", data)).toEqual({ incidents: 0, rules: 0, forms: 0 });
    expect(canDelete(usageOf("ZZZ", data))).toBe(true);
    expect(canDelete(usageOf("FIR", data))).toBe(false);
  });
  it("says why it cannot be deleted, and to hide it instead", () => {
    expect(whyNotDeletable({ incidents: 0, rules: 0, forms: 0 })).toBeNull();
    const why = whyNotDeletable({ incidents: 2, rules: 1, forms: 1 })!;
    expect(why).toContain("2 incidents use it");
    expect(why).toContain("1 notification rule names it");
    expect(why).toContain("report form files under it");
    expect(why).toContain("Hide it instead");
    expect(whyNotDeletable({ incidents: 1, rules: 0, forms: 0 })).toContain("1 incident uses it");
  });
});
