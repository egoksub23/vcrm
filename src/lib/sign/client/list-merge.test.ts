import { describe, expect, it } from "vitest";

import { EMPTY_FILTERS } from "./list-filters";
import { envelopePeople, envelopesIncluded, envelopeToRow, mergeNewestFirst, rowHref, type EnvelopeListDocument, type EnvelopeListRaw } from "./list-merge";

const person = (id: string, party: string | null, status: string, order = 1, name = id) => ({ id, party_id: party, full_name: name, status, order_no: order, kind: "signer" as const });
const doc = (id: string, position: number, signers: ReturnType<typeof person>[], status: EnvelopeListDocument["status"] = "sent"): EnvelopeListDocument => ({ id, title: `Doc ${id}`, status, envelope_position: position, sign_signers: signers });

describe("envelopePeople", () => {
  it("makes one person of the rows a person has on several documents", () => {
    const docs = [doc("d1", 1, [person("a1", "a1", "signed", 1, "Ali"), person("b1", "b1", "sent", 2, "Bea")]), doc("d2", 2, [person("a2", "a1", "pending", 1, "Ali"), person("b2", "b1", "pending", 2, "Bea")])];
    const people = envelopePeople(docs);
    expect(people.map((p) => p.full_name)).toEqual(["Ali", "Bea"]);
    // Ali signed the first but not the second: still "viewed" (partly done), not "signed"
    expect(people[0].status).toBe("viewed");
    expect(people[1].status).toBe("sent");
  });

  it("is signed only when every row is signed, declined when any is", () => {
    expect(envelopePeople([doc("d1", 1, [person("a1", "a1", "signed")]), doc("d2", 2, [person("a2", "a1", "signed")])])[0].status).toBe("signed");
    expect(envelopePeople([doc("d1", 1, [person("a1", "a1", "signed")]), doc("d2", 2, [person("a2", "a1", "declined")])])[0].status).toBe("declined");
  });

  it("ignores people handed one part of a form", () => {
    const part = { ...person("p1", null, "sent"), part_keys: ["x"] };
    expect(envelopePeople([doc("d1", 1, [part])])).toEqual([]);
  });
});

describe("envelopeToRow", () => {
  const raw: EnvelopeListRaw = {
    id: "e1", reference: "ENV-2026-000001", title: "Onboarding", status: "in_progress", contact_id: null, sign_in_order: false, sent_at: "2026-10-01T00:00:00Z", expires_at: null, completed_at: null,
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", contacts: { name: "Acme" },
    sign_documents: [doc("d2", 2, [person("a2", "a1", "pending", 1, "Ali")]), doc("d1", 1, [person("a1", "a1", "sent", 1, "Ali")])],
  };

  it("is one row with its documents in order and one entry per person", () => {
    const row = envelopeToRow(raw);
    expect(row.kind).toBe("envelope");
    expect(row.envelope_documents.map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(row.sign_signers).toHaveLength(1);
    expect(row.category_id).toBeNull();
  });

  it("opens the envelope's page, a document opens its own", () => {
    expect(rowHref(envelopeToRow(raw))).toBe("/sign/envelopes/e1");
    expect(rowHref({ id: "d9" })).toBe("/sign/d9");
  });
});

describe("mergeNewestFirst", () => {
  const d = (id: string, at: string) => ({ id, created_at: at });
  it("interleaves the two lists by date, newest first, cut to the page", () => {
    const { rows, hasMore } = mergeNewestFirst([d("d1", "2026-10-05"), d("d2", "2026-10-01")], [d("e1", "2026-10-03")], 3);
    expect(rows.map((r) => r.id)).toEqual(["d1", "e1", "d2"]);
    expect(hasMore).toBe(false);
  });

  it("says there is more when something was left out or a source returned a full page", () => {
    expect(mergeNewestFirst([d("d1", "2026-10-05"), d("d2", "2026-10-01")], [d("e1", "2026-10-03")], 2).hasMore).toBe(true);
    expect(mergeNewestFirst([d("d1", "2026-10-05")], [], 1).hasMore).toBe(true);
    expect(mergeNewestFirst([], [], 25).hasMore).toBe(false);
  });
});

describe("envelopesIncluded", () => {
  it("leaves envelopes out of the Test group and of a chosen category", () => {
    expect(envelopesIncluded(EMPTY_FILTERS)).toBe(true);
    expect(envelopesIncluded({ ...EMPTY_FILTERS, category: "none" })).toBe(true);
    expect(envelopesIncluded({ ...EMPTY_FILTERS, category: "cat-1" })).toBe(false);
    expect(envelopesIncluded({ ...EMPTY_FILTERS, group: "test" })).toBe(false);
  });
});
