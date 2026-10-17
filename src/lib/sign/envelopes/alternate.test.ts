import { describe, expect, it } from "vitest";

import type { SignRole, SignSignerRow } from "../types";
import { peopleFromRows, peopleIssues, rowsFor, type EnvelopeDocLite, type EnvelopePerson } from "./people";
import { withDerivedRoles } from "./roles";

// Someone who can sign instead of a person (migration 187) in the people model: the alternate hangs from the person they can sign instead of, is checked
// with the same rules as anyone (another address, a name), and is saved as a second row of the same role, kind and step that points at the first.

const role = (key: string, label = key): SignRole => ({ key, label, kind: "signer", color: 0 });
const UPLOAD: EnvelopeDocLite = { id: "u1", position: 1, title: "Upload", roles: [], fromTemplate: false };
const TEMPLATE: EnvelopeDocLite = { id: "t1", position: 1, title: "Template", roles: [role("merchant"), role("director")], fromTemplate: true };

const person = (key: string, fullName: string, over: Partial<EnvelopePerson> = {}): EnvelopePerson => ({ key, fullName, email: `${key}@kedai.example`, phone: "", channel: "email", step: 1, roles: {}, ...over });
const SITI = { fullName: "Siti Finance", email: "siti@kedai.example" };

const codes = (docs: EnvelopeDocLite[], people: EnvelopePerson[]) => {
  const d = withDerivedRoles(docs, people);
  return peopleIssues(d.docs, d.people, { ordered: false }).map((i) => `${i.code}${i.detail !== undefined ? `:${i.detail}` : ""}`);
};

describe("peopleIssues with someone who can sign instead", () => {
  it("is quiet for a person with a sound alternate, and an alternate does not count as a second person of the role", () => {
    expect(codes([UPLOAD], [person("pp_ali00001", "Ali", { alternate: SITI }), person("pp_bala0002", "Bala")])).toEqual([]);
    // a template's role is still held by one person: the alternate shares it and is not a second holder
    const ali = person("pp_ali00001", "Ali", { alternate: SITI, roles: { t1: "merchant" } });
    const bala = person("pp_bala0002", "Bala", { roles: { t1: "director" } });
    expect(codes([TEMPLATE], [ali, bala])).toEqual([]);
  });

  it("names the person whose alternate has no name, a bad address, or an address that is already on the list", () => {
    const ali = (alternate: { fullName: string; email: string }) => person("pp_ali00001", "Ali", { alternate });
    expect(codes([UPLOAD], [ali({ fullName: "  ", email: SITI.email })])).toEqual(["alternate_name:0"]);
    expect(codes([UPLOAD], [ali({ fullName: "Siti", email: "siti@" })])).toEqual(["alternate_email:0"]);
    expect(codes([UPLOAD], [ali({ fullName: "x".repeat(161), email: SITI.email })])).toEqual(["alternate_name:0"]);
    // the same address as the person they can sign instead of, or as anybody else, whatever the letter case
    expect(codes([UPLOAD], [ali({ fullName: "Siti", email: "PP_ALI00001@kedai.example" })])).toEqual(["alternate_duplicate:0"]);
    expect(codes([UPLOAD], [ali(SITI), person("pp_bala0002", "Bala", { email: "SITI@kedai.example" })])).toEqual(["duplicate_person:1"]);
    expect(codes([UPLOAD], [person("pp_bala0002", "Bala", { alternate: { fullName: "Dee", email: "dee@kedai.example" } }), ali({ fullName: "Dee", email: "dee@kedai.example" })])).toEqual(["alternate_duplicate:1"]);
  });

  it("is not for a Halo user", () => {
    expect(codes([UPLOAD], [person("pp_ali00001", "Ali", { alternate: SITI, internalUserId: "33333333-3333-4333-8333-333333333333" })])).toEqual(["alternate_not_here:0"]);
  });
});

describe("rowsFor with someone who can sign instead", () => {
  let n = 0;
  const newId = () => `id-${++n}`;

  it("writes a row for the alternate beside the person's own, the same role, kind and step, pointing at it, reached by email", () => {
    n = 0;
    const people = withDerivedRoles([UPLOAD], [person("pp_ali00001", "Ali", { step: 2, alternate: { fullName: " Siti Finance ", email: " siti@kedai.example " } }), person("pp_bala0002", "Bala", { step: 3, channel: "whatsapp", phone: "+60123456789" })]);
    const rows = rowsFor(people.docs, people.people, { ordered: true, newId });
    expect(rows).toHaveLength(3);
    const [first, alt, second] = rows;
    expect(first).toMatchObject({ roleKey: "pp_ali00001", fullName: "Ali", orderNo: 2 });
    expect(first.alternateOf).toBeUndefined();
    expect(alt).toMatchObject({ roleKey: "pp_ali00001", kind: first.kind, fullName: "Siti Finance", email: "siti@kedai.example", phone: null, channel: "email", orderNo: 2, alternateOf: first.id });
    expect(alt.id).not.toBe(first.id);
    expect(second.alternateOf).toBeUndefined();
    // without signing order the alternate is on the person's place like their own row
    n = 0;
    const flat = rowsFor(people.docs, people.people, { ordered: false, newId });
    expect(flat[1].orderNo).toBe(flat[0].orderNo);
    expect(flat[2].orderNo).toBe(flat[0].orderNo + 1);
  });

  it("makes no alternate for a Halo user, for a person with none, or for a person who receives a copy", () => {
    n = 0;
    const people = withDerivedRoles([UPLOAD], [person("pp_ali00001", "Ali", { alternate: SITI, internalUserId: "33333333-3333-4333-8333-333333333333" }), person("pp_bala0002", "Bala"), person("pp_cara0003", "Cara", { type: "copy", alternate: SITI })]);
    const rows = rowsFor(people.docs, people.people, { ordered: false, newId });
    expect(rows.map((r) => r.fullName)).toEqual(["Ali", "Bala"]);
  });
});

describe("peopleFromRows with someone who can sign instead", () => {
  const row = (id: string, name: string, over: Partial<SignSignerRow> = {}): SignSignerRow =>
    ({ id, account_id: "a", document_id: "d1", role_key: "pp_ali00001", kind: "signer", full_name: name, email: `${id}@kedai.example`, phone: null, channel: "email", order_no: 1, status: "pending", part_keys: null, delegated_by: null, party_id: null, alternate_of: null, internal_user_id: null, created_at: "2026-10-06T08:00:00Z", ...over }) as SignSignerRow;

  it("gives the pair back as one person with the alternate hanging from them, in either order of the rows", () => {
    const ali = row("r1", "Ali");
    const siti = row("r2", "Siti Finance", { alternate_of: "r1", email: "siti@kedai.example" });
    for (const rows of [[ali, siti], [siti, ali]]) {
      const people = peopleFromRows(rows);
      expect(people).toHaveLength(1);
      expect(people[0]).toMatchObject({ fullName: "Ali", key: "pp_ali00001", alternate: { fullName: "Siti Finance", email: "siti@kedai.example" } });
    }
  });

  it("gives a person with none back as before", () => {
    expect(peopleFromRows([row("r1", "Ali")])[0].alternate).toBeUndefined();
  });
});
