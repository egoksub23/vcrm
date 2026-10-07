import { describe, expect, it } from "vitest";

import { DOCUMENT_STATUSES, type DocumentStatus, type SignRole, type SignSignerRow } from "../types";
import { envelopeCertificateBlock } from "./certificate";
import { emptyPerson, peopleFromRows, peopleIssues, roleCoverage, rowsFor, seedPeople, type EnvelopeDocLite, type EnvelopePerson } from "./people";
import { canVoidEnvelope, deriveEnvelopeStatus, documentsDone, ENVELOPE_MAX_DOCUMENTS, ENVELOPE_MIN_DOCUMENTS } from "./status";

const roles = (...keys: string[]): SignRole[] => keys.map((key, i) => ({ key, label: key, kind: "signer", color: i }));
const D1: EnvelopeDocLite = { id: "d1", position: 1, title: "Agreement", roles: roles("merchant", "director") };
const D2: EnvelopeDocLite = { id: "d2", position: 2, title: "Fee schedule", roles: roles("merchant") };
const D3: EnvelopeDocLite = { id: "d3", position: 3, title: "Data terms", roles: roles("merchant", "witness") };

const ali = (over: Partial<EnvelopePerson> = {}): EnvelopePerson => ({ key: "a", fullName: "Ali", email: "ali@kedai.example", phone: "", channel: "email", step: 1, roles: { d1: "merchant", d2: "merchant" }, ...over });
const bala = (over: Partial<EnvelopePerson> = {}): EnvelopePerson => ({ key: "b", fullName: "Bala", email: "bala@kedai.example", phone: "", channel: "email", step: 2, roles: { d1: "director" }, ...over });

let n = 0;
const newId = () => `id${++n}`;

describe("the envelope's status from its documents", () => {
  const s = (...x: DocumentStatus[]) => deriveEnvelopeStatus(x);

  it("follows the same rule as the database's sign_envelope_derive", () => {
    expect(s()).toBe("draft");
    expect(s("draft", "draft")).toBe("draft");
    expect(s("sent", "sent")).toBe("sent");
    expect(s("in_progress", "sent")).toBe("in_progress");
    expect(s("completed", "sent")).toBe("in_progress");
    expect(s("sealing", "sent")).toBe("in_progress");
    expect(s("sealing", "sealing")).toBe("sealing");
    expect(s("completed", "sealing")).toBe("sealing");
    expect(s("completed", "completed")).toBe("completed");
    expect(s("completed", "declined")).toBe("declined");
    expect(s("declined", "declined")).toBe("declined");
    expect(s("completed", "expired")).toBe("expired");
    expect(s("declined", "expired")).toBe("declined");
    expect(s("voided", "voided")).toBe("voided");
    expect(s("voided", "expired")).toBe("expired");
    expect(s("failed", "completed")).toBe("failed");
    expect(s("draft", "sent")).toBe("draft");
  });

  it("is always one of the statuses a document can have", () => {
    const all = DOCUMENT_STATUSES;
    for (const a of all) for (const b of all) expect(all).toContain(deriveEnvelopeStatus([a, b]));
  });

  it("allows cancelling only an envelope that is out, still open, and has no document fully signed", () => {
    expect(canVoidEnvelope(["sent", "in_progress"])).toEqual({ ok: true });
    expect(canVoidEnvelope(["draft", "draft"])).toEqual({ ok: false, reason: "not_sent" });
    expect(canVoidEnvelope([])).toEqual({ ok: false, reason: "not_sent" });
    expect(canVoidEnvelope(["sealing", "sent"])).toEqual({ ok: false, reason: "partly_completed" });
    expect(canVoidEnvelope(["completed", "in_progress"])).toEqual({ ok: false, reason: "partly_completed" });
    expect(canVoidEnvelope(["failed", "sent"])).toEqual({ ok: false, reason: "partly_completed" });
    expect(canVoidEnvelope(["voided", "voided"])).toEqual({ ok: false, reason: "already_final" });
    expect(canVoidEnvelope(["expired", "declined"])).toEqual({ ok: false, reason: "already_final" });
  });

  it("counts the documents that are done, and keeps the limits it advertises", () => {
    expect(documentsDone(["completed", "sealing", "sent"])).toEqual({ done: 1, total: 3 });
    expect([ENVELOPE_MIN_DOCUMENTS, ENVELOPE_MAX_DOCUMENTS]).toEqual([2, 6]);
  });
});

describe("the shared signing list", () => {
  it("starts with one person for each role key, on every document that has the role", () => {
    const people = seedPeople([D3, D1, D2]);
    expect(people.map((p) => p.roles)).toEqual([
      { d1: "merchant", d2: "merchant", d3: "merchant" },
      { d1: "director" },
      { d3: "witness" },
    ]);
    expect(people.map((p) => p.step)).toEqual([1, 2, 3]);
  });

  it("reads saved rows back as people: rows with one party id are one person, anchor first", () => {
    const row = (id: string, documentId: string, partyId: string, over: Partial<SignSignerRow> = {}): SignSignerRow =>
      ({ id, party_id: partyId, document_id: documentId, role_key: "merchant", full_name: "Ali", email: "ali@kedai.example", phone: null, channel: "email", order_no: 1, part_keys: null, kind: "signer", ...over }) as SignSignerRow;
    const rows = [row("r2", "d2", "r1"), row("r1", "d1", "r1"), row("q1", "d1", "q1", { full_name: "Bala", email: "bala@kedai.example", role_key: "director", order_no: 2 })];
    const people = peopleFromRows(rows);
    expect(people.map((p) => [p.key, p.fullName, p.step, p.roles])).toEqual([
      ["r1", "Ali", 1, { d2: "merchant", d1: "merchant" }],
      ["q1", "Bala", 2, { d1: "director" }],
    ]);
  });

  it("shows who has each role, so a role with nobody or with two is seen", () => {
    expect(roleCoverage([D1, D2], [ali(), bala()])).toEqual([
      { documentId: "d1", roleKey: "merchant", people: 1, needed: true },
      { documentId: "d1", roleKey: "director", people: 1, needed: true },
      { documentId: "d2", roleKey: "merchant", people: 1, needed: true },
    ]);
    // a role with nothing to complete on the document (it is not in `needed`) is not asked for a person
    expect(roleCoverage([{ ...D1, needed: ["merchant"] }], []).map((c) => [c.roleKey, c.needed])).toEqual([["merchant", true], ["director", false]]);
    expect(roleCoverage([D1], [ali({ roles: { d1: "merchant" } }), bala({ roles: { d1: "merchant" } })]).find((c) => c.roleKey === "director")?.people).toBe(0);
  });

  it("finds what cannot be saved, naming the person and the document", () => {
    const issues = (people: EnvelopePerson[]) => peopleIssues([D1, D2], people, { ordered: false });
    expect(issues([ali(), bala()])).toEqual([]);
    expect(issues([ali({ fullName: " " })])).toContainEqual({ code: "signer_name", detail: "0" });
    expect(issues([ali({ email: "nope" })])).toContainEqual({ code: "signer_email", detail: "0" });
    expect(issues([ali({ channel: "whatsapp", phone: "123" })])).toContainEqual({ code: "signer_phone", detail: "0" });
    expect(issues([ali({ step: 0 })])).toContainEqual({ code: "signer_order", detail: "0" });
    expect(issues([ali(), bala({ email: "ALI@kedai.example" })])).toContainEqual({ code: "duplicate_person", detail: "1" });
    // the same Halo user on two people is one human twice (one login could open both places), whatever their addresses say
    expect(issues([ali({ internalUserId: "u-1" }), bala({ internalUserId: "u-1" })])).toContainEqual({ code: "duplicate_person", detail: "1" });
    expect(issues([ali({ internalUserId: "u-1" }), bala({ internalUserId: "u-2" })])).toEqual([]);
    expect(issues([ali({ roles: { d1: "ghost" } })])).toContainEqual({ code: "signer_role", detail: "0", document: "d1", role: "ghost" });
    expect(issues([ali({ roles: { d1: "sender" } })]).map((i) => i.code)).toContain("signer_role");
    expect(issues([ali({ roles: { nowhere: "merchant" } })]).map((i) => i.code)).toEqual(expect.arrayContaining(["signer_role", "person_without_document"]));
    expect(issues([ali({ roles: {} })])).toContainEqual({ code: "person_without_document", detail: "0" });
    expect(issues([ali({ roles: { d1: "merchant" } }), bala({ roles: { d1: "merchant" } })])).toContainEqual({ code: "role_two_people", document: "d1", role: "merchant" });
  });

  it("writes one row per document for each person: the first document's row is the anchor and every row carries the party id", () => {
    n = 0;
    const rows = rowsFor([D2, D1], [ali(), bala()], { ordered: true, newId });
    expect(rows.map((r) => [r.documentId, r.fullName, r.roleKey, r.orderNo])).toEqual([
      ["d1", "Ali", "merchant", 1],
      ["d2", "Ali", "merchant", 1],
      ["d1", "Bala", "director", 2],
    ]);
    const aliRows = rows.filter((r) => r.fullName === "Ali");
    expect(aliRows[0].id).toBe(aliRows[0].partyId);
    expect(aliRows[1].id).not.toBe(aliRows[1].partyId);
    expect(new Set(aliRows.map((r) => r.partyId)).size).toBe(1);
    expect(rows[2].partyId).not.toBe(aliRows[0].partyId);
  });

  it("keeps a person in one step on every document, and numbers people by position when there is no signing order", () => {
    n = 0;
    const ordered = rowsFor([D1, D2], [ali({ step: 3 })], { ordered: true, newId });
    expect(ordered.map((r) => r.orderNo)).toEqual([3, 3]);
    const free = rowsFor([D1, D2], [ali(), bala()], { ordered: false, newId });
    expect(free.map((r) => r.orderNo)).toEqual([1, 1, 2]);
  });

  it("makes a form-only document's people fillers, and takes the role's own kind otherwise", () => {
    n = 0;
    const form: EnvelopeDocLite = { ...D2, id: "f1", mode: "form", roles: [{ key: "merchant", label: "Merchant", kind: "filler", color: 0 }] };
    const rows = rowsFor([D1, form], [ali({ roles: { d1: "merchant", f1: "merchant" } })], { ordered: false, newId });
    expect(rows.map((r) => r.kind)).toEqual(["signer", "filler"]);
  });

  it("normalises a phone for WhatsApp and leaves it as typed otherwise", () => {
    n = 0;
    const rows = rowsFor([D1], [ali({ roles: { d1: "merchant" }, channel: "whatsapp", phone: "+60 12-345 6789" }), bala({ phone: " 012 " })], { ordered: false, newId });
    expect(rows[0].phone).toBe("+60123456789");
    expect(rows[1].phone).toBe("012");
    expect(emptyPerson(2)).toMatchObject({ fullName: "", step: 2, roles: {} });
  });
});

describe("the certificate block", () => {
  const sibs = [
    { id: "d2", title: "Fee schedule", reference: "SGN-2026-000002", base_sha256: "b".repeat(64), envelope_position: 2 },
    { id: "d1", title: "Agreement", reference: "SGN-2026-000001", base_sha256: "a".repeat(64), envelope_position: 1 },
    { id: "d3", title: "Data terms", reference: null, base_sha256: null, envelope_position: 3 },
  ];

  it("lists the documents in order with title, reference and the fingerprint as sent, and marks the one it is on", () => {
    const b = envelopeCertificateBlock("en", { id: "e1", reference: "ENV-2026-000007" }, sibs, "d2")!;
    expect(b.heading).toBe("Part of document collection ENV-2026-000007 (document 2 of 3)");
    expect(b.documents.map((d) => [d.number, d.title, d.reference, d.sha256.slice(0, 2), d.current])).toEqual([
      [1, "Agreement", "SGN-2026-000001", "aa", false],
      [2, "Fee schedule", "SGN-2026-000002", "bb", true],
      [3, "Data terms", "d3", "", false],
    ]);
    // the same block whichever document is sealed first: only the marker moves
    const other = envelopeCertificateBlock("en", { id: "e1", reference: "ENV-2026-000007" }, sibs, "d1")!;
    expect(other.documents.map((d) => d.sha256)).toEqual(b.documents.map((d) => d.sha256));
    expect(other.heading).toContain("document 1 of 3");
  });

  // migration 176: a new collection's reference starts COL-; the ones made before it keep ENV-. Nothing reads the prefix: both are shown as stored.
  it("shows a reference as stored, whichever prefix it has (COL- for a new collection, ENV- for one made before migration 176)", () => {
    for (const reference of ["COL-2026-000007", "ENV-2026-000007", "COL-2027-000123"]) {
      for (const locale of ["en", "ms", "zh", "ko"] as const) {
        const b = envelopeCertificateBlock(locale, { id: "e1", reference }, sibs, "d2")!;
        expect(b.heading, `${reference} ${locale}`).toContain(reference);
      }
    }
    expect(envelopeCertificateBlock("en", { id: "e1", reference: "COL-2026-000007" }, sibs, "d2")!.heading).toBe("Part of document collection COL-2026-000007 (document 2 of 3)");
    expect(envelopeCertificateBlock("en", { id: "e1", reference: "COL-2026-000007" }, sibs, "d2")!.heading.toLowerCase()).not.toContain("envelope");
  });

  it("is in the reader's language, and absent when there is nothing to list", () => {
    for (const locale of ["ms", "zh", "ko"] as const) {
      const b = envelopeCertificateBlock(locale, { id: "e1", reference: "ENV-1" }, sibs, "d1")!;
      expect(b.heading).toContain("ENV-1");
      expect(b.heading).not.toBe(envelopeCertificateBlock("en", { id: "e1", reference: "ENV-1" }, sibs, "d1")!.heading);
      expect(`${b.note}${b.hereLabel}${b.referenceLabel}${b.sha256Label}`).not.toContain("{");
    }
    expect(envelopeCertificateBlock("en", { id: "e1", reference: "ENV-1" }, [sibs[1]], "d1")).toBeNull();
  });
});
