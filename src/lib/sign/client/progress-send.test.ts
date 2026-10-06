import { describe, expect, it } from "vitest";

import type { FormDefinition } from "../forms/types";
import type { SignRole } from "../types";
import type { PlacedField } from "../pdf/types";
import type { SignIssue } from "./api";
import { optionsFromDocument } from "./draft-options";
import { draftProblems } from "./draft-problems";
import { errorKey, problemKey, problemNamespace, problemStep } from "./errors";
import { contactPrefill, formPartLines, partRanges, roleHolds } from "./progress-send";
import { emptyRow, type SignerRow } from "./signers-form";
import type { SignDocumentRow } from "../types";

const L = (en: string, ms?: string) => ({ en, ...(ms ? { ms } : {}) });

const roles: SignRole[] = [
  { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
  { key: "finance", label: "Finance", kind: "filler", color: 1 },
  { key: "director", label: "Director", kind: "signer", color: 2 },
];

const form: FormDefinition = {
  version: 1,
  parts: [
    { key: "p1", title: L("Company", "Syarikat"), role: "merchant" },
    { key: "p2", title: L("Address"), role: "merchant" },
    { key: "p3", title: L("Contacts"), role: "merchant" },
    { key: "p4", title: L("Tax"), role: "merchant" },
    { key: "p5", title: L("Bank"), role: "finance" },
  ],
  fields: [
    { key: "name", type: "text", part: "p1", label: L("Name"), required: true, contactField: "name" },
    { key: "mail", type: "email", part: "p1", label: L("Email"), required: true, contactField: "email" },
    { key: "co", type: "text", part: "p1", label: L("Company"), required: false, contactField: "company" },
    { key: "mail2", type: "email", part: "p3", label: L("Other email"), required: false, contactField: "email" },
    { key: "acct", type: "text", part: "p5", label: L("Account"), required: true },
  ],
};

const row = (roleKey: string, over: Partial<SignerRow> = {}): SignerRow => ({ ...emptyRow(roleKey), fullName: "Ali", email: `${roleKey}@example.com`, ...over });

describe("partRanges", () => {
  it("collapses runs of three or more, and leaves shorter runs as single numbers", () => {
    expect(partRanges([1, 2, 3, 4, 6])).toEqual([{ from: 1, to: 4 }, { from: 6, to: 6 }]);
    expect(partRanges([5])).toEqual([{ from: 5, to: 5 }]);
    expect(partRanges([1, 2])).toEqual([{ from: 1, to: 1 }, { from: 2, to: 2 }]);
    expect(partRanges([4, 2, 3, 2, 9])).toEqual([{ from: 2, to: 4 }, { from: 9, to: 9 }]);
    expect(partRanges([])).toEqual([]);
  });
});

describe("formPartLines", () => {
  it("lists each part with its number, role, colour and field counts", () => {
    const lines = formPartLines(form, roles, "ms");
    expect(lines.map((l) => [l.number, l.title, l.roleLabel, l.color, l.fieldCount, l.requiredCount])).toEqual([
      [1, "Syarikat", "Merchant", 0, 3, 2],
      [2, "Address", "Merchant", 0, 0, 0],
      [3, "Contacts", "Merchant", 0, 1, 0],
      [4, "Tax", "Merchant", 0, 0, 0],
      [5, "Bank", "Finance", 1, 1, 1],
    ]);
  });
  it("copes with a part whose role is not on the document", () => {
    const lines = formPartLines({ ...form, parts: [{ key: "x", title: L("X"), role: "ghost" }] }, roles, "en");
    expect(lines[0]).toMatchObject({ roleLabel: "ghost", color: null });
  });
});

describe("roleHolds", () => {
  it("says what each role holds and whether it signs", () => {
    const holds = roleHolds(form, roles, [row("merchant"), row("finance")], "en");
    const by = Object.fromEntries(holds.map((h) => [h.roleKey, h]));
    expect(by.merchant).toMatchObject({ mode: "partsSign", partCount: 4, ranges: [{ from: 1, to: 4 }], hasPerson: true });
    expect(by.finance).toMatchObject({ mode: "partsFill", partCount: 1, ranges: [{ from: 5, to: 5 }], titles: ["Bank"], hasPerson: true });
    expect(by.director).toMatchObject({ mode: "signOnly", partCount: 0, hasPerson: false });
  });
  it("flags a role with parts and nobody on the list", () => {
    const holds = roleHolds(form, roles, [row("merchant")], "en");
    expect(holds.find((h) => h.roleKey === "finance")?.hasPerson).toBe(false);
  });
});

describe("contactPrefill", () => {
  it("prefills from the linked contact when the form maps contact fields", () => {
    const p = contactPrefill(form, "c1");
    expect(p).toMatchObject({ willPrefill: true, warnNoContact: false, contactFields: ["name", "email", "company"] });
    expect(p.mapped).toHaveLength(4);
  });
  it("warns when it maps contact fields and no contact is chosen", () => {
    expect(contactPrefill(form, null)).toMatchObject({ willPrefill: false, warnNoContact: true });
  });
  it("says nothing for a form that maps no contact field", () => {
    const plain: FormDefinition = { ...form, fields: form.fields.filter((f) => !f.contactField) };
    expect(contactPrefill(plain, "c1")).toMatchObject({ willPrefill: false, warnNoContact: false, mapped: [] });
    expect(contactPrefill(plain, null)).toMatchObject({ willPrefill: false, warnNoContact: false });
  });
});

describe("a part with nobody to complete it stops a send", () => {
  const fields: PlacedField[] = [
    { key: "sig", type: "signature", role: "merchant", page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.05, required: true },
    { key: "dsig", type: "signature", role: "director", page: 0, x: 0.1, y: 0.3, w: 0.2, h: 0.05, required: true },
  ];
  const doc = { title: "Merchant", category_id: null, contact_id: null, locale: "en", message: null, expires_at: null, code_required: true, sign_in_order: false, reminder_days: null } as unknown as SignDocumentRow;
  const options = optionsFromDocument(doc);
  const base = { fields, roles, pageCount: 1, hasBaseFile: true };

  it("is one problem for each role that has parts and nobody", () => {
    const rows = [row("merchant"), row("director")];
    const found = draftProblems({ facts: { ...base, form }, rows, options: { ...options, title: "Merchant" }, now: new Date("2026-10-06T00:00:00Z") });
    expect(found.filter((i) => i.code === "part_without_person")).toEqual([{ code: "part_without_person", role: "finance" }]);
  });

  it("goes away once the role has a person, and never appears for a document without a form", () => {
    const rows = [row("merchant"), row("director"), row("finance")];
    const clean = draftProblems({ facts: { ...base, form }, rows, options: { ...options, title: "Merchant" }, now: new Date("2026-10-06T00:00:00Z") });
    expect(clean.some((i) => i.code === "part_without_person")).toBe(false);
    const noForm = draftProblems({ facts: { ...base, form: null }, rows: [row("merchant"), row("director")], options: { ...options, title: "Merchant" }, now: new Date("2026-10-06T00:00:00Z") });
    expect(noForm.some((i) => i.code === "part_without_person")).toBe(false);
  });

  it("is shown once when the server says it for each part too", () => {
    const rows = [row("merchant"), row("director")];
    const found = draftProblems({
      facts: { ...base, form },
      rows,
      options: { ...options, title: "Merchant" },
      // the server names the part too (one problem for each part)
      serverProblems: [{ code: "part_without_person", role: "finance", part: "p5" } as SignIssue, { code: "part_without_person", role: "finance", part: "p6" } as SignIssue],
      now: new Date("2026-10-06T00:00:00Z"),
    });
    expect(found.filter((i) => i.code === "part_without_person")).toHaveLength(1);
  });

  it("is worded with the form's words, fixed in the People step, and is not a layout problem", () => {
    expect(problemKey("part_without_person")).toBe("problems.part_without_person");
    expect(problemNamespace("part_without_person")).toBe("Sign.progress");
    expect(problemNamespace("signer_email")).toBe("Sign.send");
    expect(problemStep("part_without_person")).toBe("people");
    expect(errorKey("part_without_person")).toBe("errors.generic");
  });
});
