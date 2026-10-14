import { describe, expect, it } from "vitest";

import { renameField } from "../client/form-edit";
import { documentBadge, documentProgress, toAnswerMap } from "../client/signer-form";
import { signerFormView, formState } from "../service/form-state";
import type { PlacedField } from "../pdf/types";
import { SENDER_ROLE } from "../rules";
import { checkDataAnswer } from "./check";
import { PRINTED_NAME_UNITS, boundValues, printedFileName } from "./printing";
import { placementTypesFor, stampProblems, validateForm } from "./validate";
import type { AnswerMap, DataField, FormDefinition, StoredFile } from "./types";

const L = (en: string) => ({ en });
const f = (key: string, over: Partial<DataField> = {}): DataField => ({ key, type: "text", part: "p", label: L(key), required: false, ...over });
const roles = [{ key: "merchant", label: "Merchant", kind: "signer" as const, color: 0 }];

const form = (stamped: Partial<DataField> = {}): FormDefinition => ({
  version: 1,
  parts: [
    { key: "p", title: L("Company"), role: "merchant" },
    { key: "docs", title: L("Documents"), role: "merchant" },
  ],
  fields: [
    f("legal_name", { type: "multiline" }),
    f("brn", { sensitive: true, format: "digits", maxLength: 20 }),
    f("brn_old", { format: "alnum_hyphen", maxLength: 20 }),
    f("stamp", { type: "image", part: "docs", stamp: { nameField: "legal_name", newNumberField: "brn", oldNumberField: "brn_old" }, ...stamped }),
  ],
});

const codes = (issues: { code: string; detail?: string }[]) => issues.map((i) => (i.detail ? `${i.code}:${i.detail}` : i.code));

describe("the stamp option of a picture field", () => {
  it("is sound when it names real text fields of the same form", () => {
    expect(validateForm(form(), roles)).toEqual([]);
    // the old number is optional
    expect(validateForm(form({ stamp: { nameField: "legal_name", newNumberField: "brn" } }), roles)).toEqual([]);
  });

  it("can be switched on for a file field that takes PNG, and for no other kind of field", () => {
    expect(validateForm(form({ type: "file", accept: ["pdf", "png"], stamp: { nameField: "legal_name", newNumberField: "brn" } }), roles)).toEqual([]);
    expect(codes(validateForm(form({ type: "file", accept: ["pdf", "jpg"] }), roles))).toEqual(["bad_stamp:png"]);
    expect(codes(validateForm(form({ type: "text" }), roles))).toEqual(["bad_stamp:type"]);
    expect(codes(validateForm(form({ type: "choice", options: [{ value: "a", label: L("A") }] }), roles))).toEqual(["bad_stamp:type"]);
  });

  it("names the property that is wrong: a missing field, itself, a field that is not text, or a shape it does not know", () => {
    const bad = (stamp: unknown) => codes(stampProblems(f("stamp", { type: "image", stamp: stamp as never }), form()));
    expect(bad({ nameField: "nobody", newNumberField: "brn" })).toEqual(["bad_stamp:nameField"]);
    expect(bad({ nameField: "legal_name", newNumberField: "gone" })).toEqual(["bad_stamp:newNumberField"]);
    expect(bad({ nameField: "legal_name", newNumberField: "brn", oldNumberField: "gone" })).toEqual(["bad_stamp:oldNumberField"]);
    expect(bad({ nameField: "stamp", newNumberField: "brn" })).toEqual(["bad_stamp:nameField"]);
    expect(bad({ nameField: "legal_name" })).toEqual(["bad_stamp:newNumberField"]);
    expect(bad({ nameField: "legal_name", newNumberField: "brn", colour: "red" })).toEqual(["bad_stamp:shape"]);
    expect(bad(null)).toEqual(["bad_stamp:shape"]);
    expect(bad("legal_name")).toEqual(["bad_stamp:shape"]);
    expect(bad([])).toEqual(["bad_stamp:shape"]);
    expect(bad({ nameField: 7, newNumberField: "brn" })).toEqual(["bad_stamp:nameField"]);
    // a number field is not a name
    const withNumber = { ...form(), fields: [...form().fields, f("amount", { type: "number" })] };
    expect(codes(stampProblems(f("s", { type: "image", stamp: { nameField: "amount", newNumberField: "brn" } }), withNumber))).toEqual(["bad_stamp:nameField"]);
  });

  it("is reported by validateForm against the picture field, with the other checks intact", () => {
    const issues = validateForm(form({ stamp: { nameField: "nobody", newNumberField: "brn" } }), roles);
    expect(issues).toEqual([{ code: "bad_stamp", field: "stamp", detail: "nameField" }]);
  });

  it("follows a data field that is renamed, so the stamp keeps working", () => {
    const renamed = renameField(form(), "legal_name", "company_name");
    expect(renamed.fields.find((x) => x.key === "stamp")?.stamp).toEqual({ nameField: "company_name", newNumberField: "brn", oldNumberField: "brn_old" });
    expect(validateForm(renamed, roles)).toEqual([]);
    expect(renameField(form(), "brn_old", "old_no").fields.find((x) => x.key === "stamp")?.stamp).toEqual({ nameField: "legal_name", newNumberField: "brn", oldNumberField: "old_no" });
    // a stamp without an old number stays without one
    const noOld = { ...form(), fields: form().fields.map((x) => (x.key === "stamp" ? { ...x, stamp: { nameField: "legal_name", newNumberField: "brn" } } : x)) };
    expect(renameField(noOld, "brn", "reg").fields.find((x) => x.key === "stamp")?.stamp).toEqual({ nameField: "legal_name", newNumberField: "reg" });
  });

  it("takes an ordinary picture as its answer: the server's check of the answer is the one every picture gets", () => {
    const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const stamp = form().fields[3];
    expect(checkDataAnswer(stamp, { image: PNG })).toEqual({ ok: true, value: { image: PNG, mime: "image/png" } });
    expect(checkDataAnswer(stamp, { image: "data:image/png;base64,AAAAAAAA" })).toMatchObject({ ok: false, code: "bad_image" });
    // the option is not part of the answer: nothing special is stored
    expect(Object.keys((checkDataAnswer(stamp, { image: PNG }) as { value: object }).value).sort()).toEqual(["image", "mime"]);
  });

  it("is sent to the signer with the fields it is made from, even when another part of the form holds them", () => {
    const f2: FormDefinition = {
      version: 1,
      parts: [
        { key: "p", title: L("Company"), role: "finance" },
        { key: "docs", title: L("Documents"), role: "merchant" },
      ],
      fields: form().fields.map((x) => ({ ...x, part: x.key === "stamp" ? "docs" : "p" })),
    };
    const signers = [{ id: "s1", role_key: "merchant" }, { id: "s2", role_key: "finance" }];
    const rows = [
      { signer_id: "s2", field_key: "legal_name", value: { text: "Kedai Ali Sdn. Bhd." } },
      { signer_id: "s2", field_key: "brn", value: { text: "202101012345" } },
      { signer_id: "s2", field_key: "brn_old", value: { text: "123456-A" } },
    ];
    const view = signerFormView(f2, signers[0], formState(f2, signers, rows));
    expect(view.definition.fields.map((x) => x.key).sort()).toEqual(["brn", "brn_old", "legal_name", "stamp"]);
    expect(view.definition.fields.find((x) => x.key === "stamp")?.stamp).toEqual({ nameField: "legal_name", newNumberField: "brn", oldNumberField: "brn_old" });
    // the name and the old number are another person's answers, sent as they are; the sensitive registration number only as a fact that it exists
    expect(view.answers.legal_name).toEqual({ text: "Kedai Ali Sdn. Bhd." });
    expect(view.answers.brn).not.toEqual({ text: "202101012345" });
    // the part list of the signer is theirs alone
    expect(view.partKeys).toEqual(["docs"]);
  });
});

describe("the text shape letters, digits and hyphens (alnum_hyphen)", () => {
  const field = f("old", { format: "alnum_hyphen", maxLength: 20 });
  const ok = (v: string) => checkDataAnswer(field, { text: v });
  it("takes 123456-A and the like", () => {
    expect(ok("123456-A")).toEqual({ ok: true, value: { text: "123456-A" } });
    expect(ok("A")).toMatchObject({ ok: true });
    expect(ok("001234567-K")).toMatchObject({ ok: true });
    expect(ok("12-34-56")).toMatchObject({ ok: true });
  });
  it("refuses spaces, other marks, and hyphens at the ends or doubled", () => {
    for (const bad of ["123 456-A", "123456_A", "-123456", "123456-", "12--34", "123456/A", "１２３"]) expect(ok(bad), bad).toMatchObject({ ok: false, code: "format_alnum_hyphen" });
  });
  it("is at most as long as the field says", () => {
    expect(ok("1".repeat(21))).toMatchObject({ ok: false, code: "text_too_long", detail: "20" });
    expect(ok("1".repeat(20))).toMatchObject({ ok: true });
  });
  it("is a shape a form may use", () => {
    expect(validateForm({ ...form(), fields: [...form().fields.slice(0, 3), f("x", { format: "alnum_hyphen" })] }, roles)).toEqual([]);
  });
});

describe("a file field printed as the names of its files", () => {
  const file = (name: string, i = 0): StoredFile => ({ id: `f${i}`, name, mime: "application/pdf", size: 10, sha256: "0".repeat(64), path: `p/${name}` });
  const docForm: FormDefinition = {
    version: 1,
    parts: [{ key: "p", title: L("Docs"), role: "merchant" }],
    fields: [f("type", { type: "choice", options: [{ value: "a", label: L("A") }, { value: "b", label: L("B") }] }), f("bank", { type: "file", accept: ["pdf"], maxFiles: 3, visibleIf: { op: "eq", field: "type", value: "a" } })],
  };
  const place = (over: Partial<PlacedField> = {}): PlacedField => ({ key: "p_bank", type: "text", role: SENDER_ROLE, data: "bank", page: 0, x: 0.1, y: 0.1, w: 0.4, h: 0.05, required: false, multiline: true, fontSize: 7, ...over });
  const answers = (...names: string[]): AnswerMap => ({ type: { text: "a" }, bank: { files: names.map(file) } });

  it("allows a text box on a file field, and no other kind", () => {
    expect(placementTypesFor("file")).toEqual(["text"]);
    expect(validateForm(docForm, roles, [place()])).toEqual([]);
    for (const type of ["checkbox", "upload", "signature", "dropdown"] as const) {
      expect(codes(validateForm(docForm, roles, [place({ type })])), type).toEqual(["placement_type_mismatch:bank"]);
    }
  });

  it("prints each file name on its own line in a multi-line box, and in one line otherwise", () => {
    expect(boundValues([place()], docForm, answers("a.pdf", "b.pdf"), "en")).toEqual({ p_bank: { text: "a.pdf\nb.pdf" } });
    expect(boundValues([place({ multiline: false })], docForm, answers("a.pdf", "b.pdf"), "en")).toEqual({ p_bank: { text: "a.pdf, b.pdf" } });
  });

  it("prints nothing when nothing was uploaded, and nothing for a document that is not shown for the answers", () => {
    expect(boundValues([place()], docForm, { type: { text: "a" } }, "en")).toEqual({});
    expect(boundValues([place()], docForm, { type: { text: "b" }, bank: { files: [file("a.pdf")] } }, "en")).toEqual({});
  });

  it("never prints the server's own storage path", () => {
    const text = (boundValues([place()], docForm, answers("a.pdf"), "en").p_bank as { text: string }).text;
    expect(text).not.toContain("p/");
  });

  it("shortens a long name to one line, keeping the start and the extension, and counts a wide character double", () => {
    expect(printedFileName("form9.pdf")).toBe("form9.pdf");
    const long = `${"scan-of-the-identity-card-".repeat(5)}final.jpg`;
    const short = printedFileName(long);
    expect(Array.from(short).length).toBeLessThanOrEqual(PRINTED_NAME_UNITS);
    expect(short.endsWith("….jpg")).toBe(true);
    expect(short.startsWith("scan-of-the-identity-card-")).toBe(true);
    const wide = printedFileName(`${"董事身份证复印件".repeat(8)}.pdf`);
    expect(Array.from(wide).length).toBeLessThanOrEqual(PRINTED_NAME_UNITS / 2 + 4);
    expect(wide.endsWith("….pdf")).toBe(true);
    // a name with no extension, and with line breaks and controls in it
    expect(printedFileName("x".repeat(100)).endsWith("…")).toBe(true);
    expect(printedFileName("a\nb\u0000c.pdf")).toBe("a b c.pdf");
    expect(printedFileName("   ")).toBe("");
  });

  it("is never longer than a line of the box, whatever the file was called", () => {
    for (const name of ["a".repeat(300) + ".pdf", "W".repeat(300), "董".repeat(300) + ".jpg", "😀".repeat(100), ".hidden" + "x".repeat(100)]) {
      const out = printedFileName(name);
      const units = Array.from(out).reduce((n, ch) => n + ((ch.codePointAt(0) as number) > 0x2e80 && (ch.codePointAt(0) as number) < 0xa4cf ? 2 : 1), 0);
      expect(units, name.slice(0, 10)).toBeLessThanOrEqual(PRINTED_NAME_UNITS);
    }
  });
});

describe("a document says whether it is needed", () => {
  const docs: FormDefinition = {
    version: 1,
    parts: [{ key: "p", title: L("Docs"), role: "merchant" }, { key: "q", title: L("One"), role: "merchant" }],
    fields: [
      f("type", { type: "choice", part: "q", options: [{ value: "sdn", label: L("Sdn") }, { value: "sole", label: L("Sole") }, { value: "other", label: L("Other") }] }),
      f("form9", { type: "file", required: true, visibleIf: { op: "eq", field: "type", value: "sdn" }, accept: ["pdf"] }),
      f("form_d", { type: "file", required: true, visibleIf: { op: "eq", field: "type", value: "sole" }, accept: ["pdf"] }),
      f("bank", { type: "file", required: true, accept: ["pdf"], minFiles: 2, maxFiles: 3 }),
      f("other", { type: "file", required: false, visibleIf: { op: "eq", field: "type", value: "other" }, accept: ["pdf"] }),
      f("licence", { type: "file", required: false, requiredIf: { op: "eq", field: "type", value: "sdn" }, accept: ["pdf"] }),
      f("note", { type: "text", part: "q" }),
    ],
  };
  const file = (n: string): StoredFile => ({ id: n, name: n, mime: "application/pdf", size: 1, sha256: "0", path: "x" });
  const ans = (over: AnswerMap): AnswerMap => over;

  it("is Required for one that depends on the answers, Required for one that does not, and Optional otherwise", () => {
    const field = (k: string) => docs.fields.find((x) => x.key === k)!;
    expect(documentBadge(field("form9"), true)).toBe("requiredForType");
    expect(documentBadge(field("licence"), true)).toBe("requiredForType");
    expect(documentBadge(field("bank"), true)).toBe("required");
    expect(documentBadge(field("other"), false)).toBe("optional");
    expect(documentBadge(field("licence"), false)).toBe("optional");
  });

  it("counts the shown required documents added, and the optional ones apart", () => {
    const sdn = ans({ type: { text: "sdn" }, form9: { files: [file("f9")] } });
    // Form 9 (required, added), the bank statement (needs 2 files, has none), the licence (required for Sdn., not added)
    expect(documentProgress(docs, "p", sdn)).toEqual({ required: { done: 1, total: 3 }, optional: { done: 0, total: 0 } });
    const more = ans({ ...sdn, bank: { files: [file("b1")] } });
    // one file is not yet the two the field needs
    expect(documentProgress(docs, "p", more)?.required).toEqual({ done: 1, total: 3 });
    const full = ans({ ...sdn, bank: { files: [file("b1"), file("b2")] }, licence: { files: [file("l")] } });
    expect(documentProgress(docs, "p", full)?.required).toEqual({ done: 3, total: 3 });
    // a type with an optional document counts it apart
    const other = ans({ type: { text: "other" }, other: { files: [file("o")] } });
    expect(documentProgress(docs, "p", other)).toEqual({ required: { done: 0, total: 1 }, optional: { done: 1, total: 2 } });
  });

  it("hides what is not shown: another type's documents are not counted", () => {
    const sole = ans({ type: { text: "sole" } });
    const p = documentProgress(docs, "p", sole)!;
    expect(p.required.total).toBe(2);
  });

  it("says nothing for a part with fewer than two documents", () => {
    expect(documentProgress(docs, "q", ans({}))).toBeNull();
    // the bank statement is the only document shown for this form and these answers
    const one = { ...docs, fields: docs.fields.filter((x) => ["type", "bank", "note"].includes(x.key)) };
    expect(documentProgress(one, "p", ans({ type: { text: "sdn" } }))).toBeNull();
  });

  it("reads the answers the page holds (files without their paths)", () => {
    const held = toAnswerMap({ type: { text: "sdn" }, form9: { files: [{ id: "1", name: "a.pdf", mime: "application/pdf", size: 1, sha256: "0" }] } });
    expect(documentProgress(docs, "p", held)?.required.done).toBe(1);
  });
});
