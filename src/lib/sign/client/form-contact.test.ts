import { describe, expect, it } from "vitest";

import { validateForm } from "../forms/validate";
import { fieldOf } from "./form-edit";
import { contactChoices, customContactValue } from "./form-contact";
import { roles, sampleForm } from "./form-fixtures";

describe("contact fields an answer can fill", () => {
  it("maps a workspace field as custom:<name> and leaves out a name validateForm would refuse", () => {
    expect(customContactValue("Tax ID")).toBe("custom:Tax ID");
    expect(customContactValue("Nama syarikat")).toBe("custom:Nama syarikat");
    expect(customContactValue("公司名称")).toBe("custom:公司名称");
    expect(customContactValue("a/b")).toBeNull();
    expect(customContactValue("")).toBeNull();
    expect(customContactValue("x".repeat(61))).toBeNull();
  });

  it("every choice offered passes validateForm", () => {
    const form = sampleForm();
    const field = fieldOf(form, "legal_name")!;
    for (const c of contactChoices(["Tax ID", "Industry", "Bad/Name"])) {
      const next = { ...form, fields: form.fields.map((f) => (f === field ? { ...f, contactField: c.value, writeBack: "if_empty" as const } : f)) };
      expect(validateForm(next, roles, []), c.value).toEqual([]);
    }
  });

  it("lists built-in fields first, then the workspace's own sorted, and keeps a value that no longer exists", () => {
    const c = contactChoices(["Zone", "Industry", "Bad/Name"], "custom:Gone");
    expect(c.map((x) => x.value)).toEqual(["name", "email", "company", "custom:Industry", "custom:Zone", "custom:Gone"]);
    expect(c.at(-1)).toEqual({ value: "custom:Gone", kind: "unknown", name: "Gone" });
    expect(contactChoices([], "email")).toHaveLength(3);
  });
});
