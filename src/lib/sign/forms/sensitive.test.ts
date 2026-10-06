import { describe, expect, it } from "vitest";

import type { PlacedField } from "../pdf/types";
import type { SignRole } from "../types";
import { boundValues, canBeSensitive, DATA_FIELD_TYPES, isSensitive, maskedAnswers, maskText, maskValue, presenceOnly, printedAnswer, sensitiveKeysOf, sensitiveProblems, validateForm, type DataField, type DataFieldType, type FormDefinition, type L10n } from "./index";

const L = (en: string): L10n => ({ en });
const roles: SignRole[] = [{ key: "merchant", label: "Merchant", kind: "signer", color: 0 }];

const field = (over: Partial<DataField> & { key: string; type: DataFieldType }): DataField => ({ part: "p", label: L(over.key), required: false, ...over });
const formOf = (fields: DataField[]): FormDefinition => ({ version: 1, parts: [{ key: "p", title: L("Part"), role: "merchant" }], fields });
const codes = (form: FormDefinition) => validateForm(form, roles).map((i) => `${i.code}:${i.field ?? ""}`);

describe("masking", () => {
  it("shows the last four characters of a value longer than eight, and only the mask of a shorter one", () => {
    expect(maskText("900101-01-1234")).toBe("•••• 1234");
    expect(maskText("123456789")).toBe("•••• 6789");
    expect(maskText("12345678")).toBe("••••");
    expect(maskText("1234")).toBe("••••");
    expect(maskText("  ")).toBe("");
  });

  it("never lets the mask grow with the value", () => {
    expect(maskText("a".repeat(9)).length).toBe(maskText("a".repeat(500)).length);
    expect(maskText("a")).toBe(maskText("abcdefgh"));
  });

  it("masks text and each entry of a list, and leaves other answers alone", () => {
    expect(maskValue({ text: "900101-01-1234" })).toEqual({ text: "•••• 1234" });
    expect(maskValue({ list: ["123456789012", "short"] })).toEqual({ list: ["•••• 9012", "••••"] });
    expect(maskValue({ checked: true })).toEqual({ checked: true });
  });

  it("reduces an answer to the fact that there is one", () => {
    expect(presenceOnly({ text: "secret-value-123" })).toEqual({ text: "•" });
    expect(JSON.stringify(presenceOnly({ list: ["a-secret-one", "b-secret-two"] }))).not.toContain("secret");
  });

  it("masks only the sensitive answers of a set", () => {
    const form = formOf([field({ key: "ic", type: "text", sensitive: true }), field({ key: "name", type: "text" })]);
    const out = maskedAnswers(form, { ic: { text: "900101-01-1234" }, name: { text: "Ali bin Ahmad" } });
    expect(out.ic).toEqual({ text: "•••• 1234" });
    expect(out.name).toEqual({ text: "Ali bin Ahmad" });
    expect([...sensitiveKeysOf(form)]).toEqual(["ic"]);
  });
});

describe("which fields may be sensitive", () => {
  it("allows the typed types and not choices, files, pictures or yes/no", () => {
    const allowed = DATA_FIELD_TYPES.filter(canBeSensitive);
    expect(allowed.sort()).toEqual(["date", "email", "list", "multiline", "number", "phone", "text"]);
  });

  it("refuses the flag on a type that cannot carry it", () => {
    for (const type of ["choice", "multichoice", "yesno", "file", "image", "acknowledge"] as const) {
      const extra = type === "choice" || type === "multichoice" ? { options: [{ value: "a", label: L("A") }] } : type === "file" ? { accept: ["pdf" as const] } : type === "acknowledge" ? { text: L("I agree") } : {};
      expect(codes(formOf([field({ key: "x", type, sensitive: true, ...extra })]))).toContain("bad_sensitive:x");
    }
    expect(codes(formOf([field({ key: "x", type: "text", sensitive: true })]))).toEqual([]);
  });

  it("refuses a flag that is not true, and a print mask on a field that is not sensitive or that is not a known mask", () => {
    expect(codes(formOf([field({ key: "x", type: "text", sensitive: false })]))).toContain("bad_sensitive:x");
    expect(codes(formOf([field({ key: "x", type: "text", printMasked: "last4" })]))).toContain("bad_sensitive:x");
    expect(codes(formOf([field({ key: "x", type: "text", sensitive: true, printMasked: "half" as never })]))).toContain("bad_sensitive:x");
    expect(codes(formOf([field({ key: "x", type: "text", sensitive: true, printMasked: "last4" })]))).toEqual([]);
    expect(codes(formOf([field({ key: "x", type: "text", sensitive: true, printMasked: "none" })]))).toEqual([]);
  });

  it("refuses a sensitive field that fills the contact, or has a starting value, or is locked", () => {
    expect(codes(formOf([field({ key: "x", type: "text", sensitive: true, contactField: "company" })]))).toContain("sensitive_contact_field:x");
    expect(codes(formOf([field({ key: "x", type: "text", sensitive: true, writeBack: "if_empty" })]))).toContain("sensitive_contact_field:x");
    expect(codes(formOf([field({ key: "x", type: "text", sensitive: true, defaultValue: "123" })]))).toContain("sensitive_default:x");
    expect(codes(formOf([field({ key: "x", type: "text", sensitive: true, locked: true })]))).toContain("sensitive_default:x");
  });

  it("lets a rule ask whether a sensitive field is empty, never compare its value", () => {
    const ic = field({ key: "ic", type: "text", sensitive: true });
    const ok = formOf([ic, field({ key: "why", type: "text", visibleIf: { op: "notEmpty", field: "ic" } })]);
    expect(sensitiveProblems(ok)).toEqual([]);
    const eq = formOf([ic, field({ key: "why", type: "text", visibleIf: { op: "eq", field: "ic", value: "1" } })]);
    expect(sensitiveProblems(eq)).toEqual([{ code: "sensitive_in_rule", field: "ic" }]);
    const nested = formOf([ic, field({ key: "why", type: "text", requiredIf: { op: "and", rules: [{ op: "empty", field: "ic" }, { op: "not", rule: { op: "in", field: "ic", values: ["1"] } }] } })]);
    expect(sensitiveProblems(nested)).toEqual([{ code: "sensitive_in_rule", field: "ic" }]);
    const part: FormDefinition = { ...ok, parts: [{ key: "p", title: L("Part"), role: "merchant", visibleIf: { op: "eq", field: "ic", value: "x" } }] };
    expect(sensitiveProblems(part).map((p) => p.code)).toEqual(["sensitive_in_rule"]);
  });

  it("reports an old form with none of these as sound", () => {
    expect(sensitiveProblems(formOf([field({ key: "x", type: "text" })]))).toEqual([]);
    expect(isSensitive(undefined)).toBe(false);
    expect(isSensitive({ sensitive: false })).toBe(false);
    expect(isSensitive({ sensitive: true })).toBe(true);
  });
});

describe("printing a sensitive answer", () => {
  const placement = (key: string, data: string, over: Partial<PlacedField> = {}): PlacedField => ({ key, type: "text", role: "sender", page: 0, x: 0.1, y: 0.1, w: 0.4, h: 0.04, required: false, data, ...over });
  const form = formOf([
    field({ key: "full", type: "text", sensitive: true }),
    field({ key: "last", type: "text", sensitive: true, printMasked: "last4" }),
    field({ key: "none", type: "text", sensitive: true, printMasked: "none" }),
    field({ key: "ids", type: "list", sensitive: true, printMasked: "last4" }),
    field({ key: "plain", type: "text" }),
  ]);
  const answers = { full: { text: "900101-01-1234" }, last: { text: "900101-01-1234" }, none: { text: "900101-01-1234" }, ids: { list: ["123456789012", "short"] }, plain: { text: "Kedai Ali" } };
  const placements = ["full", "last", "none", "plain"].map((k) => placement(`p_${k}`, k)).concat(placement("p_ids", "ids", { multiline: true }));
  const out = boundValues(placements, form, answers, "en");

  it("prints in full by default, because the signed document shows what was agreed", () => {
    expect(out.p_full).toEqual({ text: "900101-01-1234" });
    expect(out.p_plain).toEqual({ text: "Kedai Ali" });
  });

  it("prints only the last four characters (with a plain star mask the PDF's font has) when the form asks", () => {
    expect(out.p_last).toEqual({ text: "**** 1234" });
    expect(out.p_ids).toEqual({ text: "**** 9012\n****" });
  });

  it("prints nothing when the form asks for that", () => {
    expect(out.p_none).toBeUndefined();
    expect(printedAnswer({ sensitive: true, printMasked: "none" }, { text: "x" })).toBeUndefined();
  });

  it("leaves an ordinary field alone whatever else is set", () => {
    expect(printedAnswer({}, { text: "Kedai" })).toEqual({ text: "Kedai" });
    expect(printedAnswer({ sensitive: true }, { text: "Kedai" })).toEqual({ text: "Kedai" });
  });
});
