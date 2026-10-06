import { describe, expect, it } from "vitest";

import type { PlacedField } from "../pdf/types";
import type { SignRole } from "../types";
import { checkDataAnswer, evalRule, fieldRequired, fieldVisible, formSendProblems, missingFormRequired, normalizePhoneMy, overallPercent, partProgress, roleProgress, ruleProblems, signReady, unsoundAnswers, validateForm, boundValues, displayValue, pick, dependencyCycle, type AnswerMap, type DataField, type FormDefinition, type L10n } from "./index";

const L = (en: string, ms?: string): L10n => ({ en, ...(ms ? { ms } : {}) });

const roles: SignRole[] = [
  { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
  { key: "finance", label: "Finance", kind: "filler", color: 1 },
];

const form: FormDefinition = {
  version: 1,
  parts: [
    { key: "company", title: L("Company"), role: "merchant" },
    { key: "tax", title: L("Tax"), role: "merchant" },
    { key: "bank", title: L("Bank"), role: "finance" },
  ],
  fields: [
    { key: "legalName", type: "multiline", part: "company", label: L("Legal name"), required: true },
    { key: "bizType", type: "choice", part: "company", label: L("Type"), required: true, options: [{ value: "sdn_bhd", label: L("Sdn. Bhd.", "Sdn. Bhd.") }, { value: "sole", label: L("Sole proprietor", "Pemilik tunggal") }] },
    { key: "brn", type: "text", part: "company", label: L("BRN"), required: true, format: "digits", minLength: 8, maxLength: 12 },
    { key: "taxType", type: "choice", part: "tax", label: L("Tax type"), required: false, options: [{ value: "sst", label: L("SST") }, { value: "na", label: L("Not applicable") }] },
    { key: "taxPct", type: "number", part: "tax", label: L("Tax %"), required: false, requiredIf: { op: "eq", field: "taxType", value: "sst" }, visibleIf: { op: "eq", field: "taxType", value: "sst" }, min: 0, max: 100, decimals: 2 },
    { key: "msic", type: "list", part: "tax", label: L("MSIC"), required: true, itemFormat: "digits", itemLength: 5, maxItems: 5 },
    { key: "postcode", type: "text", part: "company", label: L("Postcode"), required: false, format: "postcode_my" },
    { key: "accountNo", type: "text", part: "bank", label: L("Account"), required: true, format: "digits" },
    { key: "ssm", type: "file", part: "bank", label: L("Form 9"), required: true, accept: ["pdf", "jpg"], maxMb: 5, maxFiles: 2, visibleIf: { op: "eq", field: "bizType", value: "sdn_bhd" } },
  ],
};

const f = (k: string): DataField => form.fields.find((x) => x.key === k)!;
const answers = (o: AnswerMap): AnswerMap => o;

describe("rules", () => {
  it("evaluates every operator against text, yes/no and list answers", () => {
    const a = answers({ t: { text: "sst" }, y: { checked: true }, l: { list: ["47111", "47211"] }, e: { text: "" } });
    expect(evalRule({ op: "eq", field: "t", value: "sst" }, a)).toBe(true);
    expect(evalRule({ op: "ne", field: "t", value: "sst" }, a)).toBe(false);
    expect(evalRule({ op: "in", field: "t", values: ["na", "sst"] }, a)).toBe(true);
    expect(evalRule({ op: "eq", field: "y", value: "yes" }, a)).toBe(true);
    expect(evalRule({ op: "eq", field: "l", value: "47211" }, a)).toBe(true);
    expect(evalRule({ op: "empty", field: "e" }, a)).toBe(true);
    expect(evalRule({ op: "empty", field: "missing" }, a)).toBe(true);
    expect(evalRule({ op: "notEmpty", field: "l" }, a)).toBe(true);
    expect(evalRule({ op: "and", rules: [{ op: "eq", field: "t", value: "sst" }, { op: "notEmpty", field: "l" }] }, a)).toBe(true);
    expect(evalRule({ op: "or", rules: [{ op: "eq", field: "t", value: "x" }, { op: "empty", field: "l" }] }, a)).toBe(false);
    expect(evalRule({ op: "not", rule: { op: "eq", field: "t", value: "x" } }, a)).toBe(true);
  });

  it("shows and requires a field only when its rule holds", () => {
    expect(fieldVisible(form, f("taxPct"), {})).toBe(false);
    expect(fieldRequired(form, f("taxPct"), {})).toBe(false);
    const sst = answers({ taxType: { text: "sst" } });
    expect(fieldVisible(form, f("taxPct"), sst)).toBe(true);
    expect(fieldRequired(form, f("taxPct"), sst)).toBe(true);
    expect(fieldRequired(form, f("legalName"), {})).toBe(true);
  });

  it("rejects rules that refer to nothing, are too deep or too big", () => {
    const known = new Set(["a", "b"]);
    expect(ruleProblems({ op: "eq", field: "a", value: "x" }, known)).toEqual([]);
    expect(ruleProblems({ op: "eq", field: "zzz", value: "x" }, known)).toContain("rule_unknown_field");
    expect(ruleProblems({ op: "nope" }, known)).toContain("rule_shape");
    let deep: unknown = { op: "eq", field: "a", value: "x" };
    for (let i = 0; i < 6; i++) deep = { op: "not", rule: deep };
    expect(ruleProblems(deep, known)).toContain("rule_too_deep");
    const wide = { op: "and", rules: Array.from({ length: 10 }, () => ({ op: "and", rules: Array.from({ length: 10 }, () => ({ op: "empty", field: "a" })) })) };
    expect(ruleProblems(wide, known)).toContain("rule_too_big");
  });

  it("finds a loop between fields", () => {
    const loop: FormDefinition = {
      version: 1,
      parts: [{ key: "p", title: L("P"), role: "merchant" }],
      fields: [
        { key: "a", type: "text", part: "p", label: L("A"), required: false, visibleIf: { op: "notEmpty", field: "b" } },
        { key: "b", type: "text", part: "p", label: L("B"), required: false, visibleIf: { op: "notEmpty", field: "a" } },
      ],
    };
    expect(dependencyCycle(loop)).not.toBeNull();
    expect(dependencyCycle(form)).toBeNull();
  });
});

describe("checkDataAnswer", () => {
  it("accepts and normalises text, and rejects the wrong shape", () => {
    expect(checkDataAnswer(f("brn"), { text: " 201801045959 " })).toEqual({ ok: true, value: { text: "201801045959" } });
    expect(checkDataAnswer(f("brn"), { text: "2018-0104" })).toMatchObject({ ok: false, code: "format_digits" });
    expect(checkDataAnswer(f("brn"), { text: "123" })).toMatchObject({ ok: false, code: "text_too_short" });
    expect(checkDataAnswer(f("brn"), { text: "1".repeat(20) })).toMatchObject({ ok: false, code: "text_too_long" });
    expect(checkDataAnswer(f("brn"), { text: "" })).toEqual({ ok: true, value: null });
    expect(checkDataAnswer(f("postcode"), { text: "50450" })).toMatchObject({ ok: true });
    expect(checkDataAnswer(f("postcode"), { text: "5045" })).toMatchObject({ ok: false });
  });

  it("checks numbers against their range and decimals", () => {
    expect(checkDataAnswer(f("taxPct"), { text: "8" })).toEqual({ ok: true, value: { text: "8" } });
    expect(checkDataAnswer(f("taxPct"), { text: "6.125" })).toMatchObject({ ok: false, code: "too_many_decimals" });
    expect(checkDataAnswer(f("taxPct"), { text: "101" })).toMatchObject({ ok: false, code: "number_too_big" });
    expect(checkDataAnswer(f("taxPct"), { text: "abc" })).toMatchObject({ ok: false, code: "not_a_number" });
  });

  it("checks email, phone, date, choice, yes/no and lists", () => {
    const email: DataField = { key: "e", type: "email", part: "company", label: L("E"), required: false };
    expect(checkDataAnswer(email, { text: "Finance@Kedai.example" })).toEqual({ ok: true, value: { text: "finance@kedai.example" } });
    expect(checkDataAnswer(email, { text: "nope" })).toMatchObject({ ok: false, code: "bad_email" });
    const phone: DataField = { key: "p", type: "phone", part: "company", label: L("P"), required: false };
    expect(checkDataAnswer(phone, { text: "012-345 6789" })).toEqual({ ok: true, value: { text: "+60123456789" } });
    expect(checkDataAnswer(phone, { text: "+65 9123 4567" })).toEqual({ ok: true, value: { text: "+6591234567" } });
    expect(checkDataAnswer(phone, { text: "12" })).toMatchObject({ ok: false, code: "bad_phone" });
    const date: DataField = { key: "d", type: "date", part: "company", label: L("D"), required: false };
    expect(checkDataAnswer(date, { text: "2026-02-30" })).toMatchObject({ ok: false, code: "not_a_date" });
    expect(checkDataAnswer(date, { text: "2026-02-28" })).toMatchObject({ ok: true });
    expect(checkDataAnswer(f("bizType"), { text: "sdn_bhd" })).toMatchObject({ ok: true });
    expect(checkDataAnswer(f("bizType"), { text: "other" })).toMatchObject({ ok: false, code: "not_an_option" });
    const yn: DataField = { key: "y", type: "yesno", part: "company", label: L("Y"), required: false };
    expect(checkDataAnswer(yn, { checked: false })).toEqual({ ok: true, value: { checked: false } });
    expect(checkDataAnswer(f("msic"), { list: ["47111", " 47211 ", ""] })).toEqual({ ok: true, value: { list: ["47111", "47211"] } });
    expect(checkDataAnswer(f("msic"), { list: ["47111", "abcde"] })).toMatchObject({ ok: false, code: "item_format_digits" });
    expect(checkDataAnswer(f("msic"), { list: ["47111", "47111"] })).toMatchObject({ ok: false, code: "duplicate_item" });
    expect(checkDataAnswer({ ...f("msic"), itemMinLength: 5 }, { list: ["4711"] })).toMatchObject({ ok: false, code: "item_too_short" });
    expect(checkDataAnswer(f("msic"), { list: ["1", "2", "3", "4", "5", "6"] })).toMatchObject({ ok: false, code: "too_many_items" });
    expect(checkDataAnswer(f("ssm"), { text: "x" })).toMatchObject({ ok: false, code: "use_upload" });
  });

  it("an acknowledgement that is not ticked is no answer", () => {
    const ack: DataField = { key: "terms", type: "acknowledge", part: "company", label: L("Terms"), required: true, text: L("I accept") };
    expect(checkDataAnswer(ack, { checked: false })).toEqual({ ok: true, value: null });
    expect(checkDataAnswer(ack, { checked: true })).toEqual({ ok: true, value: { checked: true } });
  });

  it("normalises Malaysian phone numbers", () => {
    expect(normalizePhoneMy("0123456789")).toBe("+60123456789");
    expect(normalizePhoneMy("60123456789")).toBe("+60123456789");
    expect(normalizePhoneMy("0060123456789")).toBe("+60123456789");
    expect(normalizePhoneMy("abc")).toBeNull();
    expect(normalizePhoneMy("+60")).toBeNull();
  });
});

describe("completion", () => {
  const file = { id: "f1", name: "form9.pdf", mime: "application/pdf", size: 10, sha256: "a".repeat(64), path: "x" };

  it("reports each part as not started, in progress or done, and what is missing", () => {
    expect(roleProgress(form, "merchant", {}).map((p) => p.state)).toEqual(["not_started", "not_started"]);
    const partly = answers({ legalName: { text: "Kedai Runcit Ali Sdn Bhd" } });
    expect(partProgress(form, form.parts[0], partly)).toMatchObject({ state: "in_progress", done: 1, total: 3 });
    const done = answers({ legalName: { text: "Kedai" }, bizType: { text: "sole" }, brn: { text: "201801045959" } });
    expect(partProgress(form, form.parts[0], done).state).toBe("done");
    expect(missingFormRequired(form, "merchant", done).map((x) => x.key)).toEqual(["msic"]);
  });

  it("a conditional field joins the requirement only while shown", () => {
    const base: AnswerMap = { legalName: { text: "K" }, bizType: { text: "sole" }, brn: { text: "201801045959" }, msic: { list: ["47111"] } };
    expect(signReady(form, "merchant", answers({ ...base }))).toBe(true);
    expect(signReady(form, "merchant", answers({ ...base, taxType: { text: "sst" } }))).toBe(false);
    expect(signReady(form, "merchant", answers({ ...base, taxType: { text: "sst" }, taxPct: { text: "8" } }))).toBe(true);
    // the finance role's upload is asked only for a Sdn. Bhd.
    const fin = answers({ accountNo: { text: "123" } });
    expect(signReady(form, "finance", fin)).toBe(true);
    expect(signReady(form, "finance", answers({ ...fin, bizType: { text: "sdn_bhd" } }))).toBe(false);
    expect(signReady(form, "finance", answers({ ...fin, bizType: { text: "sdn_bhd" }, ssm: { files: [file] } }))).toBe(true);
  });

  it("a role with no parts is always ready, and the percentage counts required answers", () => {
    expect(signReady(form, "director", {})).toBe(true);
    const p = roleProgress(form, "merchant", answers({ legalName: { text: "K" }, bizType: { text: "sole" } }));
    expect(overallPercent(p)).toBe(Math.round((2 / 4) * 100));
  });

  it("finds a stored answer that is no longer sound", () => {
    const bad = answers({ legalName: { text: "K" }, brn: { text: "1234abcd" } });
    expect(unsoundAnswers(form, "merchant", bad)).toEqual([{ field: "brn", code: "format_digits" }]);
  });
});

describe("validateForm", () => {
  const placements: PlacedField[] = [
    { key: "f_name", type: "text", role: "sender", page: 0, x: 0.1, y: 0.1, w: 0.4, h: 0.04, required: false, data: "legalName", multiline: true },
    { key: "f_sdn", type: "checkbox", role: "sender", page: 0, x: 0.1, y: 0.2, w: 0.02, h: 0.02, required: false, data: "bizType", dataValue: "sdn_bhd" },
  ];

  it("passes a sound form and its bound placements", () => {
    expect(validateForm(form, roles, placements)).toEqual([]);
  });

  it("names each kind of problem", () => {
    const bad: FormDefinition = {
      version: 1,
      parts: [{ key: "p", title: { en: "" }, role: "ghost" }, { key: "p", title: L("P2"), role: "merchant" }],
      fields: [
        { key: "a", type: "choice", part: "nope", label: L("A"), required: false },
        { key: "a", type: "text", part: "p", label: L("A2"), required: false, visibleIf: { op: "eq", field: "a", value: "x" } },
        { key: "f_name", type: "text", part: "p", label: L("clash"), required: false },
        { key: "c", type: "file", part: "p", label: L("C"), required: false, accept: [] },
        { key: "d", type: "text", part: "p", label: L("D"), required: false, contactField: "phone_number" },
      ],
    };
    const codes = validateForm(bad, roles, placements).map((i) => i.code);
    for (const c of ["bad_part_title", "part_unknown_role", "duplicate_part_key", "data_unknown_part", "bad_options", "duplicate_data_key", "rule_refers_to_itself", "data_key_is_placement_key", "bad_file_types", "bad_contact_field"]) {
      expect(codes).toContain(c);
    }
  });

  it("checks what each placement prints", () => {
    const wrong: PlacedField[] = [
      { ...placements[0], key: "f_a", data: "ghost" },
      { ...placements[0], key: "f_b", type: "upload", data: "legalName" },
      { ...placements[1], key: "f_c", dataValue: undefined, type: "checkbox", data: "legalName", merge: "x" },
    ];
    const codes = validateForm(form, roles, wrong).map((i) => i.code);
    expect(codes).toContain("placement_unknown_data");
    expect(codes).toContain("placement_type_mismatch");
    expect(codes).toContain("placement_bound_and_fixed");
  });

  it("a part needs a person before sending", () => {
    expect(formSendProblems(form, [{ role_key: "merchant" }]).map((i) => i.part)).toEqual(["bank"]);
    expect(formSendProblems(form, [{ role_key: "merchant" }, { role_key: "finance" }])).toEqual([]);
  });
});

describe("printing", () => {
  const placements: PlacedField[] = [
    { key: "f_name", type: "text", role: "sender", page: 0, x: 0.1, y: 0.1, w: 0.4, h: 0.04, required: false, data: "legalName", multiline: true },
    { key: "f_type", type: "text", role: "sender", page: 0, x: 0.1, y: 0.2, w: 0.4, h: 0.04, required: false, data: "bizType" },
    { key: "f_sdn", type: "checkbox", role: "sender", page: 0, x: 0.1, y: 0.3, w: 0.02, h: 0.02, required: false, data: "bizType", dataValue: "sdn_bhd" },
    { key: "f_sole", type: "checkbox", role: "sender", page: 0, x: 0.2, y: 0.3, w: 0.02, h: 0.02, required: false, data: "bizType", dataValue: "sole" },
    { key: "f_msic", type: "text", role: "sender", page: 0, x: 0.1, y: 0.4, w: 0.4, h: 0.1, required: false, data: "msic", multiline: true },
    { key: "f_tax", type: "number", role: "sender", page: 0, x: 0.1, y: 0.5, w: 0.1, h: 0.03, required: false, data: "taxPct" },
  ];

  it("prints text, a choice by its label in the document's language, ticks and lists", () => {
    const a = answers({ legalName: { text: "Kedai Runcit Ali Sdn Bhd" }, bizType: { text: "sole" }, msic: { list: ["47111", "47211"] }, taxType: { text: "sst" }, taxPct: { text: "8" } });
    const en = boundValues(placements, form, a, "en");
    expect(en.f_name).toEqual({ text: "Kedai Runcit Ali Sdn Bhd" });
    expect(en.f_type).toEqual({ text: "Sole proprietor" });
    expect(boundValues(placements, form, a, "ms").f_type).toEqual({ text: "Pemilik tunggal" });
    expect(en.f_sole).toEqual({ checked: true });
    expect(en.f_sdn).toBeUndefined();
    expect(en.f_msic).toEqual({ text: "47111\n47211" });
    expect(en.f_tax).toEqual({ text: "8" });
  });

  it("prints nothing for a field that is hidden", () => {
    const a = answers({ taxPct: { text: "8" } });
    expect(boundValues(placements, form, a, "en").f_tax).toBeUndefined();
  });

  it("words an answer and picks a language with English as the fallback", () => {
    expect(displayValue(f("bizType"), { text: "sdn_bhd" }, "ms")).toBe("Sdn. Bhd.");
    expect(displayValue({ ...f("bizType"), type: "yesno" }, { checked: true }, "ms")).toBe("Ya");
    expect(pick(L("Hello", "Helo"), "ms")).toBe("Helo");
    expect(pick(L("Hello"), "ko")).toBe("Hello");
    expect(pick({ en: "Hello", zh: " " }, "zh")).toBe("Hello");
  });
});
