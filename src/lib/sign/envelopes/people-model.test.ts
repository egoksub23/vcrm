import { describe, expect, it } from "vitest";

import type { SignRole, SignSignerRow } from "../types";
import { MAX_COPY_RECIPIENTS, peopleFromRows, peopleIssues, rowsFor, type EnvelopeDocLite, type EnvelopePerson } from "./people";
import { withDerivedRoles } from "./roles";

// The people model (migration 175): a person is a name, an email and a type. These are the rules of the list as a whole: conflicts between people
// who must sign and people who receive a copy, the limits, the keys a saved person gets back, and the rows that are written.

const role = (key: string, label = key): SignRole => ({ key, label, kind: "signer", color: 0 });
const UPLOAD: EnvelopeDocLite = { id: "u1", position: 1, title: "Upload", roles: [], fromTemplate: false };
const TEMPLATE: EnvelopeDocLite = { id: "t1", position: 2, title: "Template", roles: [role("merchant")], fromTemplate: true };

const person = (key: string, fullName: string, over: Partial<EnvelopePerson> = {}): EnvelopePerson => ({ key, fullName, email: `${key}@kedai.example`, phone: "", channel: "email", step: 1, roles: {}, ...over });
const signer = (n: number, over: Partial<EnvelopePerson> = {}) => person(`pp_signer${n}`, `Signer ${n}`, over);
const copyOf = (n: number, over: Partial<EnvelopePerson> = {}) => person(`pp_copy000${n}`, `Copy ${n}`, { type: "copy", ...over });

const issuesFor = (docs: EnvelopeDocLite[], people: EnvelopePerson[]) => {
  const d = withDerivedRoles(docs, people);
  return peopleIssues(d.docs, d.people, { ordered: false });
};
const codes = (docs: EnvelopeDocLite[], people: EnvelopePerson[]) => issuesFor(docs, people).map((i) => `${i.code}${i.detail !== undefined ? `:${i.detail}` : ""}`);

describe("peopleIssues with people who receive a copy", () => {
  it("is quiet for signers and copies that are sound, uploaded document or not", () => {
    expect(codes([UPLOAD], [signer(1), signer(2), copyOf(1)])).toEqual([]);
  });

  it("refuses one address twice, between a signer and a copy too, whatever the letter case, naming the second", () => {
    expect(codes([UPLOAD], [signer(1, { email: "ali@kedai.example" }), copyOf(1, { email: "ALI@kedai.example" })])).toEqual(["duplicate_person:1"]);
    expect(codes([UPLOAD], [copyOf(1, { email: "x@kedai.example" }), copyOf(2, { email: "x@kedai.example" })])).toEqual(["duplicate_person:1"]);
    // the other way round: the copy comes first, so the signer is the second entry
    expect(codes([UPLOAD], [copyOf(1, { email: "x@kedai.example" }), signer(1, { email: "x@kedai.example" })])).toEqual(["duplicate_person:1"]);
  });

  it("limits the people who receive a copy to ten, counted apart from the people who must sign", () => {
    const eleven = Array.from({ length: MAX_COPY_RECIPIENTS + 1 }, (_, i) => copyOf(i));
    expect(codes([UPLOAD], [signer(1), ...eleven])).toEqual(["too_many_copies:10"]);
    expect(codes([UPLOAD], [signer(1), ...eleven.slice(0, 10)])).toEqual([]);
  });

  it("limits an uploaded file to six people who must sign (it holds six roles), but not a collection of templates", () => {
    const seven = Array.from({ length: 7 }, (_, i) => signer(i + 1));
    // the seventh person has no role to be on a document with (the service refuses the list on too_many_roles before that matters)
    expect(codes([UPLOAD], seven)).toEqual(["too_many_roles:6", "person_without_document:6"]);
    expect(codes([UPLOAD, TEMPLATE], seven)).toContain("too_many_roles:6");
    const onTemplate = seven.map((p, i) => ({ ...p, roles: { t1: i === 0 ? "merchant" : "" } }));
    expect(issuesFor([TEMPLATE], onTemplate).map((i) => i.code)).not.toContain("too_many_roles");
    // a copy recipient is not one of the six
    expect(codes([UPLOAD], [...seven.slice(0, 6), copyOf(1)])).toEqual([]);
  });

  it("checks a copy for a name and an address only: no phone, step, role or document is asked of them", () => {
    const c = copyOf(1, { channel: "whatsapp", phone: "", step: 0, roles: { gone: "x" } });
    expect(codes([UPLOAD], [signer(1), c])).toEqual([]);
    expect(codes([UPLOAD], [signer(1), copyOf(1, { fullName: " " })])).toEqual(["signer_name:1"]);
    expect(codes([UPLOAD], [signer(1), copyOf(1, { email: "nope" })])).toEqual(["signer_email:1"]);
  });

  it("still holds a signer to a phone for WhatsApp, a step, and a role that exists on the document", () => {
    expect(codes([UPLOAD], [signer(1, { channel: "whatsapp" })])).toEqual(["signer_phone:0"]);
    expect(codes([UPLOAD], [signer(1, { step: 0 })])).toEqual(["signer_order:0"]);
    const wrong = [{ ...signer(1), roles: { t1: "ghost" } }];
    expect(issuesFor([TEMPLATE], wrong)).toEqual([{ code: "signer_role", detail: "0", document: "t1", role: "ghost" }, { code: "person_without_document", detail: "0" }]);
  });
});

describe("peopleFromRows", () => {
  const row = (over: Partial<SignSignerRow>): SignSignerRow =>
    ({ id: "r", party_id: null, document_id: "d1", role_key: "merchant", kind: "signer", full_name: "Ali", email: "ali@kedai.example", phone: null, channel: "email", order_no: 1, part_keys: null, ...over }) as SignSignerRow;

  it("keys a person by the key of the role an uploaded document took from them, so it stays the same across saves, and carries the party id", () => {
    const people = peopleFromRows([row({ id: "P1", party_id: "P1", document_id: "d1", role_key: "pp_abcd1234" }), row({ id: "r2", party_id: "P1", document_id: "d2", role_key: "pp_abcd1234" })]);
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ key: "pp_abcd1234", partyId: "P1", fullName: "Ali", roles: { d1: "pp_abcd1234", d2: "pp_abcd1234" } });
  });

  it("keys a person who is only on template documents by their party id, and a person with a role of each kind by the people's role", () => {
    const template = peopleFromRows([row({ id: "P2", party_id: "P2", role_key: "merchant" })]);
    expect(template[0].key).toBe("P2");
    const mixed = peopleFromRows([row({ id: "P3", party_id: "P3", document_id: "t1", role_key: "merchant" }), row({ id: "r4", party_id: "P3", document_id: "u1", role_key: "pp_zzzz9999" })]);
    expect(mixed[0].key).toBe("pp_zzzz9999");
    expect(mixed[0].roles).toEqual({ t1: "merchant", u1: "pp_zzzz9999" });
  });

  it("takes the anchor's details, orders by step then name, keys a row without a party by its own id, and ignores a part handed to someone else", () => {
    const people = peopleFromRows([
      row({ id: "B", party_id: "B", full_name: "Bala", order_no: 2 }),
      row({ id: "A2", party_id: "A", document_id: "d2", full_name: "Ali old name", order_no: 1 }),
      row({ id: "A", party_id: "A", document_id: "d1", full_name: "Ali", order_no: 1 }),
      row({ id: "Z", party_id: null, full_name: "Zed", order_no: 1 }),
      row({ id: "D", party_id: "D", full_name: "Delegate", part_keys: ["p1"] }),
    ]);
    expect(people.map((p) => [p.fullName, p.key])).toEqual([["Ali", "A"], ["Zed", "Z"], ["Bala", "B"]]);
  });
});

describe("rowsFor with copies", () => {
  const ids = (() => {
    let n = 0;
    return () => `id${++n}`;
  })();

  it("writes rows for the people who must sign only: a copy has no row, and the places number the people who sign", () => {
    const docs = [UPLOAD];
    const people = [signer(1), copyOf(1), signer(2)];
    const d = withDerivedRoles(docs, people);
    const rows = rowsFor(d.docs, d.people, { ordered: false, newId: ids });
    expect(rows.map((r) => [r.fullName, r.roleKey, r.orderNo])).toEqual([["Signer 1", "pp_signer1", 1], ["Signer 2", "pp_signer2", 2]]);
    expect(rows.some((r) => r.email.includes("copy"))).toBe(false);
    // the anchor is on the person's first document and its id is the party id
    expect(rows.every((r) => r.id === r.partyId)).toBe(true);
  });

  it("keeps a signer's step with signing order, and writes nothing for a signer who is on no document", () => {
    const people = [signer(1, { step: 2 }), signer(2, { step: 1, roles: {} })];
    const rows = rowsFor([TEMPLATE], people.map((p, i) => (i === 0 ? { ...p, roles: { t1: "merchant" } } : p)), { ordered: true, newId: ids });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fullName: "Signer 1", orderNo: 2 });
  });
});
