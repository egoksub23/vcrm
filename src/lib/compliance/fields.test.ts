import { describe, expect, it } from "vitest";

import { MAX_FIELDS, checkAnswers, cleanL10n, expectedFileFields, fileFieldsOf, isShown, l10n, stepKeyFrom, validateChecklist, validateFieldDefs, visibleFields } from "./fields";
import { CLOSURE_ANSWERS, CLOSURE_FIELDS, L, withBankOwn } from "./test-support";
import type { FieldDef } from "./types";

const fields = CLOSURE_FIELDS as unknown as FieldDef[];

describe("l10n / cleanL10n", () => {
  it("falls back to English, then the fallback", () => {
    expect(l10n({ en: "Hello", ms: "Helo" }, "ms")).toBe("Helo");
    expect(l10n({ en: "Hello", ms: "Helo" }, "zh")).toBe("Hello");
    expect(l10n({ en: "Hello", ms: "  " }, "ms")).toBe("Hello");
    expect(l10n(undefined, "en", "key")).toBe("key");
  });
  it("keeps the four languages, trims, needs English", () => {
    expect(cleanL10n({ en: " Hi ", ms: "x", fr: "bonjour", zh: 3 })).toEqual({ en: "Hi", ms: "x" });
    expect(cleanL10n({ ms: "x" })).toBeNull();
    expect(cleanL10n("Hi")).toBeNull();
    expect(cleanL10n(null)).toBeNull();
  });
});

describe("validateFieldDefs", () => {
  it("accepts the seeded fields", () => {
    const r = validateFieldDefs(CLOSURE_FIELDS);
    expect(r.ok).toBe(true);
  });
  it("rejects a bad key, a duplicate, an unknown type, a missing English label and too many fields", () => {
    const f = (over: Record<string, unknown>) => ({ key: "a", type: "text", label: L("A"), required: false, sensitive: false, ...over });
    const codes = (v: unknown) => {
      const r = validateFieldDefs(v);
      return r.ok ? [] : r.issues.map((i) => i.code);
    };
    expect(codes([f({ key: "Bad Key" })])).toEqual(["bad_key"]);
    expect(codes([f({}), f({})])).toEqual(["duplicate_key"]);
    expect(codes([f({ type: "signature" })])).toEqual(["bad_type"]);
    expect(codes([f({ label: { ms: "x" } })])).toEqual(["bad_label"]);
    expect(codes("nope")).toEqual(["bad_fields"]);
    expect(codes(Array.from({ length: MAX_FIELDS + 1 }, (_, i) => f({ key: `k${i}` })))).toEqual(["too_many_fields"]);
  });
  it("lets only text-like types be sensitive, and a choice needs options", () => {
    const base = { key: "a", label: L("A"), required: false };
    const r1 = validateFieldDefs([{ ...base, type: "acknowledge", sensitive: true }]);
    expect(r1.ok).toBe(false);
    const r2 = validateFieldDefs([{ ...base, type: "file", sensitive: true }]);
    expect(r2.ok).toBe(false);
    const r3 = validateFieldDefs([{ ...base, type: "choice", sensitive: false }]);
    expect(r3.ok).toBe(false);
    const r4 = validateFieldDefs([{ ...base, type: "choice", sensitive: false, options: [{ value: "x", label: L("X") }] }]);
    expect(r4.ok).toBe(true);
    const r5 = validateFieldDefs([{ ...base, type: "number", sensitive: true }]);
    expect(r5.ok).toBe(true);
  });
});

describe("validateChecklist / stepKeyFrom", () => {
  it("accepts keyed steps with an English label and refuses the rest", () => {
    expect(validateChecklist([{ key: "one", label: { en: "One" } }]).ok).toBe(true);
    expect(validateChecklist([{ key: "One", label: { en: "One" } }]).ok).toBe(false);
    expect(validateChecklist([{ key: "one", label: { ms: "x" } }]).ok).toBe(false);
    expect(validateChecklist([{ key: "one", label: { en: "a" } }, { key: "one", label: { en: "b" } }]).ok).toBe(false);
    expect(validateChecklist("x").ok).toBe(false);
    expect(validateChecklist(Array.from({ length: 21 }, (_, i) => ({ key: `s${i}`, label: { en: "x" } }))).ok).toBe(false);
  });
  it("makes a step key from the words, unique", () => {
    expect(stepKeyFrom("Close the account!", new Set())).toBe("close_the_account");
    expect(stepKeyFrom("Close the account!", new Set(["close_the_account"]))).toBe("close_the_account_2");
    expect(stepKeyFrom("123 456", new Set())).toBe("step");
    expect(stepKeyFrom("关闭账户", new Set())).toBe("step");
  });
});

describe("checkAnswers", () => {
  it("separates ordinary and sensitive answers, and cleans values", () => {
    const r = checkAnswers(fields, CLOSURE_ANSWERS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answers.data).toEqual({ confirm_closure: true, children_finished_school: true, allowances_cancelled: true, reason: "Moving abroad" });
    expect(Object.keys(r.answers.sensitive).sort()).toEqual(["bank_account_holder", "bank_account_number", "bank_name"]);
  });

  it("requires what is required and the ticks, and says which", () => {
    const r = checkAnswers(fields, { reason: "x" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.filter((i) => i.code === "must_acknowledge").map((i) => i.field)).toEqual(["confirm_closure", "children_finished_school", "allowances_cancelled"]);
    expect(r.issues.filter((i) => i.code === "required").map((i) => i.field)).toEqual(["bank_name", "bank_account_number", "bank_account_holder"]);
  });

  it("refuses an unticked acknowledgement even when sent as false, and accepts the string 'true'", () => {
    expect(checkAnswers(fields, { ...CLOSURE_ANSWERS, allowances_cancelled: false }).ok).toBe(false);
    expect(checkAnswers(fields, { ...CLOSURE_ANSWERS, allowances_cancelled: "true" }).ok).toBe(true);
  });

  it("checks each type: phone, email, number, date, choice, yes/no, text length", () => {
    const defs = validateFieldDefs([
      { key: "p", type: "phone", label: L("P"), required: true },
      { key: "e", type: "email", label: L("E"), required: true },
      { key: "n", type: "number", label: L("N"), required: true },
      { key: "d", type: "date", label: L("D"), required: true },
      { key: "c", type: "choice", label: L("C"), required: true, options: [{ value: "a", label: L("A") }] },
      { key: "y", type: "yesno", label: L("Y"), required: true },
      { key: "t", type: "text", label: L("T"), required: true },
    ]);
    if (!defs.ok) throw new Error("fixture");
    const good = { p: "012-345 6789", e: "a@b.my", n: "1,250.456", d: "2026-02-28", c: "a", y: "false", t: "hello" };
    const ok = checkAnswers(defs.fields, good);
    expect(ok.ok && ok.answers.data).toEqual({ p: "+60123456789", e: "a@b.my", n: 1250.46, d: "2026-02-28", c: "a", y: false, t: "hello" });
    const bad = (k: string, v: unknown) => {
      const r = checkAnswers(defs.fields, { ...good, [k]: v });
      return r.ok ? null : r.issues.find((i) => i.field === k)?.code;
    };
    expect(bad("p", "abc")).toBe("invalid");
    expect(bad("e", "a@b")).toBe("invalid");
    expect(bad("n", "-5")).toBe("invalid");
    expect(bad("n", "ten")).toBe("invalid");
    expect(bad("d", "2026-02-30")).toBe("invalid");
    expect(bad("d", "28/02/2026")).toBe("invalid");
    expect(bad("c", "z")).toBe("not_a_choice");
    expect(bad("y", "maybe")).toBe("invalid");
    expect(bad("t", "x".repeat(301))).toBe("too_long");
    expect(bad("t", { not: "text" })).toBe("invalid");
    expect(bad("t", "   ")).toBe("required");
  });

  it("a partial edit checks only what is sent; unknown keys are dropped; files are skipped", () => {
    const r = checkAnswers(fields, { reason: "new", bank_account_number: "123456789", authorization_letter: "file.pdf", surprise: "x" }, { partial: true });
    expect(r.ok && r.answers).toEqual({ data: { reason: "new" }, sensitive: { bank_account_number: "123456789" } });
    expect(checkAnswers(fields, { bank_account_number: "" }, { partial: true }).ok).toBe(false);
  });

  it("keeps a sensitive number as text, so it is encrypted as the digits typed", () => {
    const defs = validateFieldDefs([{ key: "acct", type: "number", label: L("A"), required: true, sensitive: true }]);
    if (!defs.ok) throw new Error("fixture");
    const r = checkAnswers(defs.fields, { acct: "8800123456789012" });
    expect(r.ok && r.answers.sensitive).toEqual({ acct: "8800123456789012" });
  });

  it("finds the file fields of a type", () => {
    expect(fileFieldsOf(fields).map((f) => f.key)).toEqual(["authorization_letter"]);
  });
});

describe("the bank account question (migration 186): a yes / no answer controls the authorization letter", () => {
  const defs = withBankOwn(CLOSURE_FIELDS) as unknown as FieldDef[];
  const letter = defs.find((f) => f.key === "authorization_letter")!;

  it("shows a field that depends on a yes / no answer by true or false, and hides it while the question is unanswered", () => {
    expect(isShown(letter, defs, { bank_account_is_own: false })).toBe(true);
    expect(isShown(letter, defs, { bank_account_is_own: true })).toBe(false);
    expect(isShown(letter, defs, {})).toBe(false);
    // a stored string answer (what a staff form holds) works too
    expect(isShown(letter, defs, { bank_account_is_own: "false" })).toBe(true);
    expect(isShown(letter, defs, { bank_account_is_own: "true" })).toBe(false);
    expect(visibleFields(defs, { bank_account_is_own: true }).some((f) => f.key === "authorization_letter")).toBe(false);
  });

  it("puts the question right before the bank details and keeps the letter a required, conditional file", () => {
    const keys = defs.map((f) => f.key);
    expect(keys.indexOf("bank_account_is_own")).toBe(keys.indexOf("bank_name") - 1);
    expect(letter).toMatchObject({ type: "file", required: true, showIf: { field: "bank_account_is_own", in: ["false"] } });
    const q = defs.find((f) => f.key === "bank_account_is_own")!;
    expect(q).toMatchObject({ type: "yesno", required: true, sensitive: false });
    expect(validateFieldDefs(defs).ok).toBe(true);
  });

  it("requires the answer, accepts true and false, and never asks the file field through the answers", () => {
    const base = { ...CLOSURE_ANSWERS } as Record<string, unknown>;
    delete base.bank_account_is_own;
    const missing = checkAnswers(defs, base);
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.issues).toEqual([{ field: "bank_account_is_own", code: "required" }]);
    for (const v of [true, false, "true", "false"]) {
      const r = checkAnswers(defs, { ...base, bank_account_is_own: v });
      expect(r.ok && r.answers.data.bank_account_is_own, String(v)).toBe(v === true || v === "true");
    }
    expect(checkAnswers(defs, { ...base, bank_account_is_own: "maybe" })).toMatchObject({ ok: false, issues: [{ field: "bank_account_is_own", code: "invalid" }] });
    // a letter is never an answer
    const withFile = checkAnswers(defs, { ...base, bank_account_is_own: false, authorization_letter: "x.pdf" });
    expect(withFile.ok && "authorization_letter" in withFile.answers.data).toBe(false);
  });

  it("expects the letter among a case's documents only after a No (and while the question was never answered)", () => {
    expect(expectedFileFields(defs, { bank_account_is_own: false }).map((f) => f.key)).toEqual(["authorization_letter"]);
    expect(expectedFileFields(defs, { bank_account_is_own: true })).toEqual([]);
    expect(expectedFileFields(defs, {}).map((f) => f.key)).toEqual(["authorization_letter"]);
  });
});
