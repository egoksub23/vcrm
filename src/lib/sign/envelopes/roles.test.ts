import { describe, expect, it } from "vitest";

import type { FormDefinition } from "../forms/types";
import type { PlacedField } from "../pdf/types";
import type { SignRole } from "../types";
import { emptyPerson, type EnvelopeDocLite, type EnvelopePerson } from "./people";
import { autoMatchTemplateRoles, peopleRoles, pruneRows, roleHasWork, roleLabelFor, syncDocumentRoles, withDerivedRoles, withPeopleRoles, withUploadRoles } from "./roles";

// The people model's roles (migration 175): where the roles of an uploaded document come from, how a template's roles are matched to people,
// and who signs what at send. Pure functions, so no screen and no database.

const person = (key: string, fullName: string, over: Partial<EnvelopePerson> = {}): EnvelopePerson => ({
  key,
  fullName,
  email: `${fullName.toLowerCase().replace(/\W+/g, ".")}@kedai.example`,
  phone: "",
  channel: "email",
  step: 1,
  roles: {},
  ...over,
});
const copy = (key: string, fullName: string): EnvelopePerson => person(key, fullName, { type: "copy" });

const ALI = person("pp_aaaa1111", "Ali");
const BALA = person("pp_bbbb2222", "Bala");
const CARA = copy("pp_cccc3333", "Cara");

const role = (key: string, label = key, over: Partial<SignRole> = {}): SignRole => ({ key, label, kind: "signer", color: 0, ...over });
const field = (key: string, r: string, over: Partial<PlacedField> = {}): PlacedField => ({ key, type: "signature", role: r, page: 0, x: 0.1, y: 0.1, w: 0.3, h: 0.05, required: true, ...over });

const UPLOAD: EnvelopeDocLite = { id: "u1", position: 1, title: "Upload", roles: [], fromTemplate: false };
const UPLOAD2: EnvelopeDocLite = { id: "u2", position: 3, title: "Upload 2", roles: [], fromTemplate: false };
const TEMPLATE: EnvelopeDocLite = { id: "t1", position: 2, title: "Template", roles: [role("merchant", "Merchant"), role("director", "Director")], fromTemplate: true };

describe("peopleRoles", () => {
  it("makes one role of each person who must sign: key = the person's key, label = their name, colour = their place, source people", () => {
    expect(peopleRoles([ALI, CARA, BALA])).toEqual([
      { key: "pp_aaaa1111", label: "Ali", kind: "signer", color: 0, source: "people" },
      { key: "pp_bbbb2222", label: "Bala", kind: "signer", color: 1, source: "people" },
    ]);
  });

  it("gives two people of one name their address so the roles can be told apart, in any letter case", () => {
    const a = person("pp_aaaa1111", "Ali", { email: "ali@one.example" });
    const b = person("pp_bbbb2222", "ALI", { email: "ali@two.example" });
    expect(peopleRoles([a, b]).map((r) => r.label)).toEqual(["Ali (ali@one.example)", "ALI (ali@two.example)"]);
    // a copy recipient of the same name is not a role, so it does not make a clash
    expect(peopleRoles([a, copy("pp_cccc3333", "Ali")]).map((r) => r.label)).toEqual(["Ali"]);
  });

  it("names a person with no name yet by their place, and keeps a label to the 60 characters a role holds", () => {
    expect(peopleRoles([person("pp_aaaa1111", "  "), BALA]).map((r) => r.label)).toEqual(["Person 1", "Bala"]);
    expect(roleLabelFor({ fullName: "x".repeat(80), email: "" }, [], 1)).toHaveLength(60);
    const longClash = person("pp_aaaa1111", "y".repeat(55), { email: "long@kedai.example" });
    expect(peopleRoles([longClash, person("pp_bbbb2222", "y".repeat(55))])[0].label).toHaveLength(60);
  });

  it("holds six roles: a seventh person has none, and the colours 0 to 5 are all different", () => {
    const eight = Array.from({ length: 8 }, (_, i) => person(`pp_person0${i}`, `Person ${String.fromCharCode(65 + i)}`));
    const roles = peopleRoles(eight);
    expect(roles).toHaveLength(6);
    expect(roles.map((r) => r.color)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(roles.map((r) => r.key)).toEqual(eight.slice(0, 6).map((p) => p.key));
  });
});

describe("withDerivedRoles", () => {
  it("gives each uploaded document the people's roles and each person who must sign the role on each uploaded document; a template document is left as it is", () => {
    const docs = [UPLOAD, TEMPLATE, UPLOAD2];
    const ali = { ...ALI, roles: { t1: "merchant" } };
    const out = withDerivedRoles(docs, [ali, BALA, CARA]);
    expect(out.docs.find((d) => d.id === "u1")!.roles.map((r) => r.key)).toEqual(["pp_aaaa1111", "pp_bbbb2222"]);
    expect(out.docs.find((d) => d.id === "u2")!.roles.map((r) => r.key)).toEqual(["pp_aaaa1111", "pp_bbbb2222"]);
    expect(out.docs.find((d) => d.id === "t1")!.roles.map((r) => r.key)).toEqual(["merchant", "director"]);
    expect(out.people[0].roles).toEqual({ t1: "merchant", u1: "pp_aaaa1111", u2: "pp_aaaa1111" });
    expect(out.people[1].roles).toEqual({ u1: "pp_bbbb2222", u2: "pp_bbbb2222" });
    // a copy has no role, even where a document would give everyone one
    expect(out.people[2].roles).toEqual({});
    // the input is not changed
    expect(ali.roles).toEqual({ t1: "merchant" });
    expect(UPLOAD.roles).toEqual([]);
  });

  it("takes a stale role off an uploaded document for a person who has no role (beyond the sixth), and a document with no fromTemplate flag is taken to be a template's", () => {
    const seven = Array.from({ length: 7 }, (_, i) => person(`pp_person0${i}`, `Person ${i}`));
    const out = withUploadRoles([UPLOAD], seven.map((p, i) => (i === 6 ? { ...p, roles: { u1: "stale" } } : p)));
    expect(out[6].roles).toEqual({});
    const undecided: EnvelopeDocLite = { id: "x", position: 1, title: "x", roles: [role("a")] };
    expect(withPeopleRoles([undecided], [ALI])[0].roles.map((r) => r.key)).toEqual(["a"]);
  });
});

describe("syncDocumentRoles", () => {
  const old = role("pp_gone0000", "Gone", { source: "people", color: 0 });
  const legacy = role("editor_role", "Editor role");
  const legacyUnused = role("unused", "Unused");

  it("replaces the roles with the people's, drops (and counts) the fields of a person who is gone, keeps the sender's fields and a legacy role while a field uses it", () => {
    const fields = [field("f1", "pp_gone0000"), field("f2", "editor_role"), field("f3", "sender", { type: "static_text", text: "RM 1", required: false }), field("f4", "pp_aaaa1111"), field("f5", "pp_gone0000", { type: "text" })];
    const out = syncDocumentRoles({ roles: [old, legacy, legacyUnused], fields }, [ALI, CARA]);
    expect(out.roles.map((r) => r.key)).toEqual(["pp_aaaa1111", "editor_role"]);
    expect(out.fields.map((f) => f.key)).toEqual(["f2", "f3", "f4"]);
    expect(out.removed).toBe(2);
    expect(out.changed).toBe(true);
  });

  it("is unchanged when the roles already are the people's, and changed when only the legacy role was unused or a label moved", () => {
    const fields = [field("f1", "pp_aaaa1111")];
    const same = syncDocumentRoles({ roles: peopleRoles([ALI, BALA]), fields }, [ALI, BALA]);
    expect(same).toMatchObject({ changed: false, removed: 0 });
    expect(same.fields).toEqual(fields);
    expect(syncDocumentRoles({ roles: [...peopleRoles([ALI, BALA]), legacyUnused], fields }, [ALI, BALA]).changed).toBe(true);
    // a rename keeps the key (so the fields assigned stay) and moves the label
    const renamed = syncDocumentRoles({ roles: peopleRoles([ALI]), fields }, [{ ...ALI, fullName: "Ali bin Ahmad" }]);
    expect(renamed.roles[0]).toMatchObject({ key: "pp_aaaa1111", label: "Ali bin Ahmad" });
    expect(renamed.fields).toEqual(fields);
    expect(renamed).toMatchObject({ changed: true, removed: 0 });
  });

  it("drops every field of a person list that is empty, except the sender's", () => {
    const out = syncDocumentRoles({ roles: peopleRoles([ALI]), fields: [field("f1", "pp_aaaa1111"), field("f2", "sender", { type: "static_text", text: "x" })] }, []);
    expect(out.roles).toEqual([]);
    expect(out.fields.map((f) => f.key)).toEqual(["f2"]);
    expect(out.removed).toBe(1);
  });
});

describe("autoMatchTemplateRoles", () => {
  it("gives a role to the person whose name is its label, ignoring case and extra spaces", () => {
    const out = autoMatchTemplateRoles([TEMPLATE], [person("pp_aaaa1111", "  MERCHANT "), person("pp_bbbb2222", "director"), person("pp_dddd4444", "Zed")]);
    expect(out[0].roles).toEqual({ t1: "merchant" });
    expect(out[1].roles).toEqual({ t1: "director" });
    expect(out[2].roles).toEqual({});
  });

  it("matches the one role to the one person who must sign, but not when there are two people or two roles", () => {
    const solo: EnvelopeDocLite = { id: "t2", position: 4, title: "Solo", roles: [role("merchant", "Merchant")], fromTemplate: true };
    expect(autoMatchTemplateRoles([solo], [ALI])[0].roles).toEqual({ t2: "merchant" });
    expect(autoMatchTemplateRoles([solo], [ALI, BALA]).every((p) => Object.keys(p.roles).length === 0)).toBe(true);
    expect(autoMatchTemplateRoles([TEMPLATE], [ALI])[0].roles).toEqual({});
    // a copy recipient is not "the one person" who must sign: a collection of one signer and one copy still matches the signer
    const out = autoMatchTemplateRoles([solo], [CARA, ALI]);
    expect(out[0].roles).toEqual({});
    expect(out[1].roles).toEqual({ t2: "merchant" });
  });

  it("never overwrites what the sender chose, never puts one person in two roles of a document, and never two people in one role", () => {
    const chosen = person("pp_aaaa1111", "Director", { roles: { t1: "merchant" } });
    const out = autoMatchTemplateRoles([TEMPLATE], [chosen]);
    // the person chose merchant: their name would match director, but they are already on the document
    expect(out[0].roles).toEqual({ t1: "merchant" });
    const twin1 = person("pp_aaaa1111", "Merchant");
    const twin2 = person("pp_bbbb2222", "merchant");
    const two = autoMatchTemplateRoles([TEMPLATE], [twin1, twin2]);
    expect(two.filter((p) => p.roles.t1 === "merchant")).toHaveLength(1);
    // a role somebody already has is not given to a second person
    const taken = autoMatchTemplateRoles([TEMPLATE], [person("pp_aaaa1111", "Zed", { roles: { t1: "merchant" } }), twin2]);
    expect(taken[1].roles).toEqual({});
    // a copy named like a role is not matched
    expect(autoMatchTemplateRoles([TEMPLATE], [copy("pp_cccc3333", "Merchant")])[0].roles).toEqual({});
  });

  it("leaves uploaded documents alone and does not change its input", () => {
    const people = [person("pp_aaaa1111", "Merchant")];
    const out = autoMatchTemplateRoles([UPLOAD, TEMPLATE], people);
    expect(out[0].roles).toEqual({ t1: "merchant" });
    expect(people[0].roles).toEqual({});
    expect(emptyPerson().roles).toEqual({});
  });
});

describe("who signs what: roleHasWork and pruneRows", () => {
  const form: FormDefinition = { version: 1, parts: [{ key: "p1", title: { en: "Details" }, role: "former" }], fields: [] };
  const doc = (id: string, fields: PlacedField[], formSnapshot?: FormDefinition | null) => ({ id, fields_snapshot: fields, form_snapshot: formSnapshot ?? null });

  it("a role has work when a person answers something: a signature, initials, text, date, checkbox... but not static text, a merge field, a name, a signing date or a printed answer", () => {
    const d = doc("d1", [
      field("s", "signer_role"),
      field("st", "static_role", { type: "static_text", text: "x", required: false }),
      field("mg", "merge_role", { type: "text", merge: "bank_name" }),
      field("nm", "name_role", { type: "name" }),
      field("ds", "date_role", { type: "date_signed" }),
      field("bd", "bound_role", { type: "text", data: "answer" }),
      field("tx", "text_role", { type: "text", required: false }),
    ]);
    expect(roleHasWork(d, "signer_role")).toBe(true);
    expect(roleHasWork(d, "text_role")).toBe(true);
    for (const r of ["static_role", "merge_role", "name_role", "date_role", "bound_role", "nobody"]) expect(roleHasWork(d, r)).toBe(false);
  });

  it("counts a part of the form as work for its role", () => {
    const d = doc("d1", [], form);
    expect(roleHasWork(d, "former")).toBe(true);
    expect(roleHasWork(d, "other")).toBe(false);
    expect(roleHasWork({ id: "d2", fields_snapshot: [] }, "former")).toBe(false);
  });

  it("keeps the rows with work and drops the rest, including a row on a document that is not there", () => {
    const docs = [doc("d1", [field("s", "b"), field("nm", "a", { type: "name" })]), doc("d2", [field("s2", "a")], form)];
    const rows = [
      { document_id: "d1", role_key: "a", id: 1 },
      { document_id: "d1", role_key: "b", id: 2 },
      { document_id: "d2", role_key: "a", id: 3 },
      { document_id: "d2", role_key: "former", id: 4 },
      { document_id: "gone", role_key: "a", id: 5 },
    ];
    const { keep, dropped } = pruneRows(docs, rows);
    expect(keep.map((r) => r.id)).toEqual([2, 3, 4]);
    expect(dropped.map((r) => r.id)).toEqual([1, 5]);
    expect(pruneRows(docs, [])).toEqual({ keep: [], dropped: [] });
  });
});
