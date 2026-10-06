import { describe, expect, it } from "vitest";

import { validateForm } from "../forms/validate";
import { fieldOf } from "./form-edit";
import { L, roles, sampleForm } from "./form-fixtures";
import { coverage, formTexts, setText, textIn } from "./form-text";

describe("setText", () => {
  it("sets a language and keeps the others", () => {
    expect(setText({ en: "Name" }, "ms", "Nama", true)).toEqual({ en: "Name", ms: "Nama" });
    expect(setText({ en: "Name", ms: "Nama" }, "en", "Full name", true)).toEqual({ en: "Full name", ms: "Nama" });
  });

  it("removes a language left empty so it falls back to English", () => {
    expect(setText({ en: "Name", ms: "Nama" }, "ms", "", true)).toEqual({ en: "Name" });
    expect(setText({ en: "Name" }, "zh", "", true)).toEqual({ en: "Name" });
  });

  it("keeps English present while it is being typed, for a required text", () => {
    expect(setText({ en: "A" }, "en", "", true)).toEqual({ en: "" });
    expect(setText(undefined, "ms", "Nama", true)).toEqual({ en: "", ms: "Nama" });
  });

  it("an optional text with nothing in any language is not there at all", () => {
    expect(setText({ en: "Help" }, "en", "", false)).toBeUndefined();
    expect(setText(undefined, "en", "", false)).toBeUndefined();
    expect(setText(undefined, "en", "Help", false)).toEqual({ en: "Help" });
    // text only in another language is kept, so the problem (English is required) is shown, not hidden
    expect(setText({ en: "Help", ms: "Bantuan" }, "en", "", false)).toEqual({ en: "", ms: "Bantuan" });
  });

  it("what it makes for a field's texts passes validateForm when English is there", () => {
    const form = sampleForm();
    const f = fieldOf(form, "legal_name")!;
    const next = { ...form, fields: form.fields.map((x) => (x === f ? { ...x, label: setText(x.label, "ko", "법인명", true)!, help: setText(undefined, "en", "As on SSM", false) } : x)) };
    expect(validateForm(next, roles, [])).toEqual([]);
  });

  it("reads the typed text, not the fallback", () => {
    expect(textIn(L("Name", "Nama"), "ms")).toBe("Nama");
    expect(textIn(L("Name"), "ms")).toBe("");
    expect(textIn(undefined, "en")).toBe("");
  });
});

describe("coverage", () => {
  it("counts every text a signer reads and how many are translated", () => {
    const form = sampleForm();
    const total = formTexts(form).length;
    // 3 parts + 7 field labels + 4 option labels
    expect(total).toBe(14);
    expect(coverage(form, "en")).toEqual({ done: 14, total: 14 });
    expect(coverage(form, "ms")).toEqual({ done: 1, total: 14 });
    expect(coverage(form, "ko")).toEqual({ done: 0, total: 14 });
  });
});
