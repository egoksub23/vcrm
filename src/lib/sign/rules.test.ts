import { describe, expect, it } from "vitest";

import type { PlacedField } from "./pdf/types";
import {
  MAX_FIELDS,
  SENDER_ROLE,
  checkAnswer,
  decodeImageDataUrl,
  fieldsForRole,
  missingRequired,
  normalizePhone,
  sendProblems,
  validateFields,
  validateRoles,
  type SignerDraft,
} from "./rules";
import type { SignRole } from "./types";

const roles: SignRole[] = [
  { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
  { key: "finance", label: "Finance", kind: "filler", color: 1 },
  { key: "director", label: "Director", kind: "signer", color: 2 },
];

const f = (over: Partial<PlacedField> & Pick<PlacedField, "key" | "type">): PlacedField => ({
  role: "merchant",
  page: 0,
  x: 0.1,
  y: 0.1,
  w: 0.3,
  h: 0.05,
  required: true,
  ...over,
});

const codes = (issues: { code: string }[]) => issues.map((i) => i.code).sort();

// a tiny valid PNG and JPEG header, base64
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]).toString("base64");
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]).toString("base64");

describe("validateRoles", () => {
  it("accepts a sound set", () => {
    expect(validateRoles(roles)).toEqual([]);
  });

  it("rejects duplicates, the reserved sender key, bad kinds and more than six roles", () => {
    expect(codes(validateRoles([roles[0], roles[0]]))).toEqual(["duplicate_role"]);
    expect(codes(validateRoles([{ ...roles[0], key: SENDER_ROLE }]))).toEqual(["bad_role_key"]);
    expect(codes(validateRoles([{ ...roles[0], kind: "boss" as never }]))).toEqual(["bad_role_kind"]);
    expect(codes(validateRoles([{ ...roles[0], label: "" }]))).toEqual(["bad_role_label"]);
    const seven = Array.from({ length: 7 }, (_, i) => ({ ...roles[0], key: `r${i}` }));
    expect(codes(validateRoles(seven))).toContain("too_many_roles");
  });
});

describe("validateFields", () => {
  it("accepts a sound layout", () => {
    const fields = [f({ key: "name", type: "name" }), f({ key: "sig", type: "signature", y: 0.5, h: 0.08 }), f({ key: "fee", type: "static_text", text: "RM 1", role: SENDER_ROLE })];
    expect(validateFields(fields, roles, 2)).toEqual([]);
  });

  it("checks keys, types, roles and pages", () => {
    expect(codes(validateFields([f({ key: "1bad", type: "text" })], roles, 1))).toEqual(["bad_field_key"]);
    expect(codes(validateFields([f({ key: "a", type: "text" }), f({ key: "a", type: "text" })], roles, 1))).toEqual(["duplicate_field_key"]);
    expect(codes(validateFields([f({ key: "a", type: "sparkle" as never })], roles, 1))).toEqual(["bad_field_type"]);
    expect(codes(validateFields([f({ key: "a", type: "text", role: "nobody" })], roles, 1))).toEqual(["unknown_role"]);
    expect(codes(validateFields([f({ key: "a", type: "text", page: 2 })], roles, 2))).toEqual(["page_out_of_range"]);
  });

  it("keeps fields on the page and not vanishingly small", () => {
    expect(codes(validateFields([f({ key: "a", type: "text", x: 0.8, w: 0.3 })], roles, 1))).toEqual(["outside_page"]);
    expect(codes(validateFields([f({ key: "a", type: "text", w: 0 })], roles, 1))).toEqual(["outside_page"]);
    expect(codes(validateFields([f({ key: "a", type: "text", x: Number.NaN })], roles, 1))).toEqual(["outside_page"]);
    expect(codes(validateFields([f({ key: "a", type: "text", w: 0.001 })], roles, 1))).toEqual(["too_small"]);
  });

  it("stops a filler owning a signature, initials or signing date", () => {
    expect(codes(validateFields([f({ key: "a", type: "signature", role: "finance" })], roles, 1))).toEqual(["filler_cannot_sign"]);
    expect(codes(validateFields([f({ key: "a", type: "date_signed", role: "finance" })], roles, 1))).toEqual(["filler_cannot_sign"]);
    expect(validateFields([f({ key: "a", type: "text", role: "finance" })], roles, 1)).toEqual([]);
  });

  it("checks type-specific properties", () => {
    expect(codes(validateFields([f({ key: "a", type: "dropdown" })], roles, 1))).toEqual(["bad_options"]);
    expect(codes(validateFields([f({ key: "a", type: "dropdown", options: ["x", "x"] })], roles, 1))).toEqual(["bad_options"]);
    expect(validateFields([f({ key: "a", type: "dropdown", options: ["x", "y"] })], roles, 1)).toEqual([]);
    expect(codes(validateFields([f({ key: "a", type: "date", dateFormat: "DD <b>" })], roles, 1))).toEqual(["bad_date_format"]);
    expect(validateFields([f({ key: "a", type: "date", dateFormat: "DD/MM/YYYY" })], roles, 1)).toEqual([]);
    expect(codes(validateFields([f({ key: "a", type: "number", decimals: 9 })], roles, 1))).toEqual(["bad_decimals"]);
    expect(codes(validateFields([f({ key: "a", type: "static_text", role: SENDER_ROLE })], roles, 1))).toEqual(["bad_static_text"]);
    expect(validateFields([f({ key: "a", type: "text", role: SENDER_ROLE, merge: "business_name" })], roles, 1)).toEqual([]);
    expect(codes(validateFields([f({ key: "a", type: "text", merge: "bad key!" })], roles, 1))).toEqual(["bad_merge_key"]);
    expect(codes(validateFields([f({ key: "a", type: "text", fontSize: 2 })], roles, 1))).toEqual(["bad_font_size"]);
  });

  it("caps the number of fields", () => {
    const many = Array.from({ length: MAX_FIELDS + 1 }, (_, i) => f({ key: `k${i}`, type: "text" }));
    expect(codes(validateFields(many, roles, 1))).toContain("too_many_fields");
  });
});

describe("checkAnswer", () => {
  it("trims and bounds text, and drops control characters", () => {
    const text = f({ key: "t", type: "text" });
    expect(checkAnswer(text, { text: "  Kedai Runcit  " })).toEqual({ ok: true, value: { text: "Kedai Runcit" } });
    expect(checkAnswer(text, { text: "a\u0000b\nc" })).toEqual({ ok: true, value: { text: "ab c" } });
    expect(checkAnswer(text, { text: "x".repeat(201) })).toEqual({ ok: false, code: "text_too_long" });
    expect(checkAnswer(text, { text: "" })).toEqual({ ok: true, value: null });
    expect(checkAnswer(text, { text: "   " })).toEqual({ ok: true, value: null });
    expect(checkAnswer(text, { text: 5 })).toEqual({ ok: false, code: "text_too_long" });
    expect(checkAnswer(text, undefined)).toEqual({ ok: true, value: null });
    const multi = f({ key: "m", type: "text", multiline: true });
    expect(checkAnswer(multi, { text: "line 1\nline 2" })).toEqual({ ok: true, value: { text: "line 1\nline 2" } });
    expect(checkAnswer(multi, { text: "x".repeat(2001) })).toEqual({ ok: false, code: "text_too_long" });
  });

  it("reads numbers with separators and refuses anything else", () => {
    const n = f({ key: "n", type: "number" });
    expect(checkAnswer(n, { text: "1,234,567.50" })).toEqual({ ok: true, value: { text: "1234567.50" } });
    expect(checkAnswer(n, { text: "-12" })).toEqual({ ok: true, value: { text: "-12" } });
    expect(checkAnswer(n, { text: "12abc" })).toEqual({ ok: false, code: "not_a_number" });
    expect(checkAnswer(n, { text: "1e9" })).toEqual({ ok: false, code: "not_a_number" });
    expect(checkAnswer(n, { text: "1".repeat(16) })).toEqual({ ok: false, code: "not_a_number" });
  });

  it("accepts real dates only", () => {
    const d = f({ key: "d", type: "date" });
    expect(checkAnswer(d, { text: "2026-10-06" })).toEqual({ ok: true, value: { text: "2026-10-06" } });
    expect(checkAnswer(d, { text: "2026-02-30" })).toEqual({ ok: false, code: "not_a_date" });
    expect(checkAnswer(d, { text: "06/10/2026" })).toEqual({ ok: false, code: "not_a_date" });
  });

  it("accepts a dropdown value only from the options", () => {
    const o = f({ key: "o", type: "dropdown", options: ["Basic", "Plus"] });
    expect(checkAnswer(o, { text: "Plus" })).toEqual({ ok: true, value: { text: "Plus" } });
    expect(checkAnswer(o, { text: "Gold" })).toEqual({ ok: false, code: "not_an_option" });
  });

  it("accepts a boolean for a checkbox", () => {
    const c = f({ key: "c", type: "checkbox" });
    expect(checkAnswer(c, { checked: true })).toEqual({ ok: true, value: { checked: true } });
    expect(checkAnswer(c, { checked: false })).toEqual({ ok: true, value: { checked: false } });
    expect(checkAnswer(c, { checked: "yes" })).toEqual({ ok: false, code: "not_a_checkbox" });
  });

  it("accepts a drawn signature (a real PNG or JPEG) or a short typed one", () => {
    const s = f({ key: "s", type: "signature" });
    expect(checkAnswer(s, { image: `data:image/png;base64,${PNG}` })).toMatchObject({ ok: true, value: { mime: "image/png" } });
    expect(checkAnswer(s, { image: `data:image/jpeg;base64,${JPG}` })).toMatchObject({ ok: true, value: { mime: "image/jpeg" } });
    expect(checkAnswer(s, { typed: "Ali Ahmad" })).toEqual({ ok: true, value: { typed: "Ali Ahmad" } });
    expect(checkAnswer(s, { image: `data:image/png;base64,${JPG}` })).toEqual({ ok: false, code: "bad_image" }); // a JPEG labelled PNG
    expect(checkAnswer(s, { image: "data:text/html;base64,PGI+" })).toEqual({ ok: false, code: "bad_image" });
    expect(checkAnswer(s, { image: "https://example.com/x.png" })).toEqual({ ok: false, code: "bad_image" });
    expect(checkAnswer(s, { typed: "x".repeat(101) })).toEqual({ ok: false, code: "bad_typed_signature" });
    expect(checkAnswer(s, {})).toEqual({ ok: true, value: null });
    const i = f({ key: "i", type: "initials" });
    expect(checkAnswer(i, { typed: "AA" })).toEqual({ ok: true, value: { typed: "AA" } });
    expect(checkAnswer(i, { typed: "A".repeat(11) })).toEqual({ ok: false, code: "bad_typed_signature" });
  });

  it("refuses an oversize image", () => {
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(500 * 1024)]).toString("base64");
    expect(decodeImageDataUrl(`data:image/png;base64,${big}`)).toBeNull();
  });

  it("ignores input for fields nobody enters", () => {
    expect(checkAnswer(f({ key: "a", type: "date_signed" }), { text: "2026-10-06" })).toEqual({ ok: true, value: null });
    expect(checkAnswer(f({ key: "b", type: "static_text", role: SENDER_ROLE, text: "x" }), { text: "hack" })).toEqual({ ok: true, value: null });
  });
});

describe("what a role completes", () => {
  const fields = [
    f({ key: "name", type: "name" }),
    f({ key: "sig", type: "signature" }),
    f({ key: "when", type: "date_signed" }),
    f({ key: "fee", type: "static_text", text: "RM 1", role: SENDER_ROLE }),
    f({ key: "biz", type: "text", merge: "business_name", role: "merchant" }),
    f({ key: "note", type: "text", required: false }),
    f({ key: "bank", type: "text", role: "finance" }),
  ];

  it("leaves out static, merge and automatic fields (the signer's name and the signing date write themselves)", () => {
    expect(fieldsForRole(fields, "merchant").map((x) => x.key)).toEqual(["sig", "note"]);
    expect(fieldsForRole(fields, "finance").map((x) => x.key)).toEqual(["bank"]);
  });

  it("lists the required ones without an answer", () => {
    expect(missingRequired(fields, "merchant", new Set()).map((x) => x.key)).toEqual(["sig"]);
    expect(missingRequired(fields, "merchant", new Set(["note"])).map((x) => x.key)).toEqual(["sig"]);
    expect(missingRequired(fields, "merchant", new Set(["sig"]))).toEqual([]);
  });
});

describe("normalizePhone", () => {
  it("accepts international numbers and tidies them", () => {
    expect(normalizePhone("+60 12-345 6789")).toBe("+60123456789");
    expect(normalizePhone("+1 (415) 555-0100")).toBe("+14155550100");
    expect(normalizePhone("0123456789")).toBeNull();
    expect(normalizePhone("+12")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});

describe("sendProblems", () => {
  const fields = [f({ key: "sig", type: "signature" }), f({ key: "name", type: "name" }), f({ key: "dsig", type: "signature", role: "director" })];
  const signer = (over: Partial<SignerDraft> = {}): SignerDraft => ({
    role_key: "merchant",
    kind: "signer",
    full_name: "Ali bin Ahmad",
    email: "ali@kedairuncit.example",
    channel: "email",
    order_no: 1,
    ...over,
  });
  const base = { fields, roles, signers: [signer(), signer({ role_key: "director", full_name: "Gokula", email: "g@vircle.example", order_no: 2 })], signInOrder: false, pageCount: 2, hasBaseFile: true };
  const problems = (over: Partial<typeof base> = {}) => codes(sendProblems({ ...base, ...over }));

  it("lets a sound document go", () => {
    expect(problems()).toEqual([]);
    expect(problems({ signInOrder: true })).toEqual([]);
  });

  it("needs a file and a signer", () => {
    expect(problems({ hasBaseFile: false })).toContain("no_file");
    expect(problems({ signers: [] })).toContain("no_signer");
    expect(problems({ signers: [signer({ kind: "filler", role_key: "finance" })], fields: [f({ key: "bank", type: "text", role: "finance" })] })).toContain("no_signer");
  });

  it("checks each signer's details", () => {
    expect(problems({ signers: [signer({ full_name: " " })] })).toContain("signer_name");
    expect(problems({ signers: [signer({ email: "nope" })] })).toContain("signer_email");
    expect(problems({ signers: [signer({ channel: "whatsapp", phone: "0123" })] })).toContain("signer_phone");
    expect(problems({ signers: [signer({ channel: "whatsapp", phone: "+60123456789" })] })).not.toContain("signer_phone");
    expect(problems({ signers: [signer({ role_key: "ghost" })] })).toContain("signer_role");
    expect(problems({ signers: [signer({ order_no: 0 })] })).toContain("signer_order");
  });

  it("needs a person for every role that has something to complete", () => {
    expect(problems({ signers: [signer()] })).toContain("role_without_person"); // director has a signature field
  });

  it("needs a signature for every signer", () => {
    expect(problems({ fields: [f({ key: "name", type: "name" })], roles: [roles[0]], signers: [signer()] })).toContain("signer_without_signature");
  });

  it("with signing order lets two people share a number (one step) but not be on the list twice", () => {
    const two = [signer(), signer({ role_key: "director", email: "g@vircle.example", order_no: 1 })];
    expect(problems({ signers: two, signInOrder: true })).toEqual([]);
    expect(problems({ signers: two, signInOrder: false })).toEqual([]);
    const same = [signer(), signer({ role_key: "director", order_no: 2 })];
    expect(problems({ signers: same, signInOrder: true })).toContain("same_person_twice");
    expect(problems({ signers: same, signInOrder: false })).not.toContain("same_person_twice");
  });

  it("includes layout problems", () => {
    expect(problems({ fields: [...fields, f({ key: "bad", type: "text", page: 5 })] })).toContain("page_out_of_range");
  });
});
