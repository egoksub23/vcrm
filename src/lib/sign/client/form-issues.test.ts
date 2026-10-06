import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { validateForm } from "../forms/validate";
import type { FormDefinition } from "../forms/types";
import { fieldOf } from "./form-edit";
import { L, placement, placements, roles, sampleForm } from "./form-fixtures";
import { BUILDER_ERROR_CODES, FORM_ISSUE_CODES, FORM_WARNING_CODES, builderErrorKey, formIssueMessageKey, formWarningMessageKey, formWarnings, issueParams, issueTarget, roleWarnings } from "./form-issues";

const root = join(process.cwd(), "src/lib/sign");
const messages = (locale: string) => JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as { Sign?: { formBuilder?: Record<string, Record<string, unknown>> } };
const codesIn = (file: string, re: RegExp) => [...readFileSync(join(root, file), "utf8").matchAll(re)].map((m) => m[1]);

describe("issue codes", () => {
  it("has a message for every code validateForm and its rule checks can raise", () => {
    const raised = new Set([...codesIn("forms/validate.ts", /code: "([a-z_]+)"/g), ...codesIn("forms/rules.ts", /problems\.push\("([a-z_]+)"\)/g)]);
    expect(raised.size).toBeGreaterThan(25);
    for (const code of raised) expect(FORM_ISSUE_CODES as readonly string[], `no message for ${code}`).toContain(code);
    for (const code of raised) expect(formIssueMessageKey(code)).toBe(`issues.${code}`);
  });

  it("answers a generic message for a code it does not know", () => {
    expect(formIssueMessageKey("brand_new")).toBe("issues.unknown");
    expect(formWarningMessageKey("part_empty")).toBe("warnings.part_empty");
    expect(formWarningMessageKey("brand_new")).toBe("warnings.unknown");
    expect(FORM_WARNING_CODES).toContain("static_text_does_not_fit");
  });
});

// Once the translations of the builder are merged into messages/*.json (Sign.formBuilder), every code must be worded in every language.
const merged = messages("en").Sign?.formBuilder !== undefined;
describe.runIf(merged)("issue, warning and error messages in the catalogues", () => {
  for (const locale of ["en", "ms", "zh", "ko"]) {
    it(`has a message for every code in ${locale}`, () => {
      const fb = messages(locale).Sign?.formBuilder;
      expect(fb, `Sign.formBuilder in ${locale}`).toBeDefined();
      for (const code of FORM_ISSUE_CODES) expect(fb?.issues?.[code], `issues.${code}`).toBeTypeOf("string");
      for (const code of FORM_WARNING_CODES) expect(fb?.warnings?.[code], `warnings.${code}`).toBeTypeOf("string");
      for (const code of BUILDER_ERROR_CODES) expect(fb?.errors?.[code], `errors.${code}`).toBeTypeOf("string");
      expect(fb?.issues?.unknown).toBeTypeOf("string");
      expect(fb?.warnings?.unknown).toBeTypeOf("string");
      expect(fb?.errors?.generic).toBeTypeOf("string");
    });
  }
});

describe("builder error codes", () => {
  it("words a known code and falls back to the generic message for the rest", () => {
    expect(builderErrorKey("changed_elsewhere")).toBe("errors.changed_elsewhere");
    expect(builderErrorKey("template_has_no_version")).toBe("errors.template_has_no_version");
    expect(builderErrorKey("something_else")).toBe("errors.generic");
    expect(BUILDER_ERROR_CODES.length).toBeGreaterThan(8);
  });
});

describe("what an issue is about", () => {
  it("points at a placement for placement codes, a field, a part, a role or the form", () => {
    expect(issueTarget({ code: "placement_unknown_data", field: "p_1" })).toEqual({ kind: "placement", placement: "p_1" });
    expect(issueTarget({ code: "data_key_is_placement_key", field: "name" })).toEqual({ kind: "field", field: "name" });
    expect(issueTarget({ code: "bad_part_title", part: "tax" })).toEqual({ kind: "part", part: "tax" });
    expect(issueTarget({ code: "part_unknown_role", part: "tax", role: "x" })).toEqual({ kind: "part", part: "tax" });
    expect(issueTarget({ code: "x", role: "finance" })).toEqual({ kind: "role", role: "finance" });
    expect(issueTarget({ code: "too_many_parts" })).toEqual({ kind: "form" });
  });

  it("names the field, part, role and page a message talks about", () => {
    const ctx = { form: sampleForm(), roles, placements, locale: "ms" as const };
    expect(issueParams({ code: "bad_limit", field: "tax_pct" }, ctx)).toMatchObject({ field: "Peratusan cukai", part: "Tax" });
    expect(issueParams({ code: "part_unknown_role", part: "bank", role: "finance" }, ctx)).toMatchObject({ part: "Bank", role: "Finance" });
    expect(issueParams({ code: "placement_type_mismatch", field: "p_pct", detail: "tax_pct" }, ctx)).toMatchObject({ field: "Peratusan cukai", page: 2, detail: "tax_pct" });
  });
});

describe("live validation of what the builder produces", () => {
  it("a sound form has no issues; breaking it shows stable codes with where", () => {
    const form = sampleForm();
    expect(validateForm(form, roles, placements)).toEqual([]);
    const broken: FormDefinition = { ...form, fields: form.fields.map((f) => (f.key === "msic" ? { ...f, label: { en: "" } } : f)), parts: form.parts.map((p) => (p.key === "bank" ? { ...p, role: "ghost" } : p)) };
    const issues = validateForm(broken, roles, placements);
    expect(issues).toEqual(expect.arrayContaining([{ code: "bad_data_label", field: "msic" }, { code: "part_unknown_role", part: "bank", role: "ghost" }]));
    for (const i of issues) expect(formIssueMessageKey(i.code)).not.toBe("issues.unknown");
  });
});

describe("soft warnings", () => {
  it("warns about a part with nothing in it", () => {
    const form = { ...sampleForm(), parts: [...sampleForm().parts, { key: "empty", title: L("Empty"), role: "merchant" }] };
    expect(formWarnings(form, [])).toContainEqual({ code: "part_empty", part: "empty" });
  });

  it("warns about a rule that compares with a value the field does not offer, and about a blank one", () => {
    const form = sampleForm();
    const pct = fieldOf(form, "tax_pct")!;
    const next = { ...form, fields: form.fields.map((f) => (f === pct ? { ...f, visibleIf: { op: "eq" as const, field: "tax_type", value: "gone" }, requiredIf: { op: "eq" as const, field: "legal_name", value: "" } } : f)) };
    const w = formWarnings(next, []);
    expect(w).toContainEqual({ code: "rule_value_not_option", field: "tax_pct", detail: "gone" });
    expect(w).toContainEqual({ code: "rule_blank_value", field: "tax_pct" });
  });

  it("warns about a default that is not an option and a tick bound to an option that went", () => {
    const form = sampleForm();
    const taxType = fieldOf(form, "tax_type")!;
    const next = { ...form, fields: form.fields.map((f) => (f === taxType ? { ...f, defaultValue: "zzz", options: [{ value: "na", label: L("NA") }] } : f)) };
    const w = formWarnings(next, placements);
    expect(w).toContainEqual({ code: "default_not_option", field: "tax_type", detail: "zzz" });
    expect(w).toContainEqual({ code: "placement_option_missing", placement: "p_sst", field: "tax_type" });
    expect(formWarnings(form, placements)).toEqual([]);
  });

  it("warns about a signer who holds parts but nothing to sign, never about a filler", () => {
    const form = sampleForm();
    expect(roleWarnings(form, roles, placements)).toEqual([]);
    expect(roleWarnings(form, roles, [placement({ key: "p_x", data: "legal_name" })])).toEqual([{ code: "role_signer_no_signature", role: "merchant" }]);
    // the filler holds the bank part and has no signature field: no warning
    expect(roleWarnings(form, roles, []).map((w) => w.role)).not.toContain("finance");
    // a signer with no parts is not named
    expect(roleWarnings({ ...form, parts: form.parts.filter((p) => p.role !== "merchant") }, roles, [])).toEqual([]);
  });
});
