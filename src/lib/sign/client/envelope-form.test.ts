import { describe, expect, it } from "vitest";

import { seedPeople, type EnvelopeDocLite, type EnvelopePerson } from "../envelopes";
import type { SignEnvelopeRow } from "../types";
import {
  addPerson,
  dedupeEnvelopeIssues,
  envelopePatch,
  fixFor,
  groupByDocument,
  normalizePersonSteps,
  optionsFromEnvelope,
  peopleKey,
  peoplePayload,
  personHasInput,
  personIsComplete,
  removePerson,
  setPersonRole,
  updatePerson,
} from "./envelope-form";

const role = (key: string) => ({ key, label: key, kind: "signer" as const, color: 0 });
const docs: EnvelopeDocLite[] = [
  { id: "d1", position: 1, title: "Contract", roles: [role("merchant"), role("director")] },
  { id: "d2", position: 2, title: "Fees", roles: [role("merchant")] },
];

const env: SignEnvelopeRow = {
  id: "e1", account_id: "a1", reference: "ENV-2026-000001", title: "Onboarding", status: "draft", contact_id: "c1", message: null, locale: "ms", sign_in_order: true, code_required: false,
  reminder_days: [3, 7], expires_at: null, sent_at: null, completed_at: null, void_reason: null, end_notified_at: null, created_by: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
};

const ali = (over: Partial<EnvelopePerson> = {}): EnvelopePerson => ({ key: "p1", fullName: "Ali", email: "ali@example.com", phone: "", channel: "email", step: 1, roles: { d1: "merchant", d2: "merchant" }, ...over });

describe("the options", () => {
  it("reads the envelope's own options and leaves out what does not apply", () => {
    const o = optionsFromEnvelope(env);
    expect(o).toMatchObject({ title: "Onboarding", contactId: "c1", locale: "ms", signInOrder: true, categoryId: null, allowForwarding: false });
  });

  it("patches only what changed, never a category or forwarding", () => {
    const saved = optionsFromEnvelope(env);
    const patch = envelopePatch(saved, { ...saved, title: "Renamed", allowForwarding: true, categoryId: "x" }, new Date("2026-10-07T00:00:00Z"));
    expect(patch).toEqual({ title: "Renamed" });
  });
});

describe("the people", () => {
  it("is complete with a name, an address, a step and a role that the document has", () => {
    expect(personIsComplete(ali(), docs)).toBe(true);
    expect(personIsComplete(ali({ fullName: " " }), docs)).toBe(false);
    expect(personIsComplete(ali({ email: "nope" }), docs)).toBe(false);
    expect(personIsComplete(ali({ roles: { d1: "stranger" } }), docs)).toBe(false);
    expect(personIsComplete(ali({ roles: {} }), docs)).toBe(false);
    expect(personIsComplete(ali({ channel: "whatsapp", phone: "123" }), docs)).toBe(false);
  });

  it("saves only the complete people, with the roles the documents have", () => {
    const half = ali({ key: "p2", email: "" });
    const payload = peoplePayload([ali({ roles: { d1: "merchant", d2: "ghost" } }), half], docs, true);
    expect(payload).toHaveLength(1);
    expect(payload[0].roles).toEqual({ d1: "merchant" });
    expect(personHasInput(half)).toBe(true);
    expect(personHasInput(ali({ fullName: "", email: "", phone: "" }))).toBe(false);
  });

  it("numbers the steps by position when there is no signing order, and keeps them when there is", () => {
    const two = [ali(), ali({ key: "p2", fullName: "Bea", email: "bea@example.com", step: 5, roles: { d1: "director" } })];
    expect(peoplePayload(two, docs, false).map((p) => p.step)).toEqual([1, 2]);
    expect(peoplePayload(two, docs, true).map((p) => p.step)).toEqual([1, 5]);
  });

  it("is the same key for the same list, so a save that changes nothing is skipped", () => {
    expect(peopleKey(peoplePayload([ali()], docs, true))).toBe(peopleKey(peoplePayload([ali()], docs, true)));
    expect(peopleKey(peoplePayload([ali()], docs, true))).not.toBe(peopleKey(peoplePayload([ali({ fullName: "Aly" })], docs, true)));
  });

  it("adds a person on every document that still has a role nobody has", () => {
    const start = seedPeople(docs);
    expect(start).toHaveLength(2); // merchant, director
    const next = addPerson([start[0]], docs);
    // the merchant is taken on both documents, the director is free on the first
    expect(next[1].roles).toEqual({ d1: "director" });
    expect(next[1].step).toBe(start[0].step + 1);
  });

  it("gives a role, takes it away, renames and removes", () => {
    let list = [ali({ roles: {} })];
    list = setPersonRole(list, "p1", "d1", "director");
    expect(list[0].roles).toEqual({ d1: "director" });
    list = setPersonRole(list, "p1", "d1", "");
    expect(list[0].roles).toEqual({});
    list = updatePerson(list, "p1", { fullName: "Aliyah" });
    expect(list[0].fullName).toBe("Aliyah");
    expect(removePerson(list, "p1")).toEqual([]);
  });

  it("renumbers the steps without a gap and keeps people who shared a step together", () => {
    const list = [ali({ key: "a", step: 3 }), ali({ key: "b", step: 3 }), ali({ key: "c", step: 9 })];
    expect(normalizePersonSteps(list).map((p) => p.step)).toEqual([1, 1, 2]);
  });
});

describe("what is wrong and where it is put right", () => {
  it("sends people problems to the people, option problems to the options, others to their document", () => {
    expect(fixFor({ code: "signer_email" })).toEqual({ kind: "people" });
    expect(fixFor({ code: "duplicate_person" })).toEqual({ kind: "people" });
    expect(fixFor({ code: "envelope_size" })).toEqual({ kind: "people" });
    expect(fixFor({ code: "title_required" })).toEqual({ kind: "options" });
    expect(fixFor({ code: "invalid_layout", document: "d2" })).toEqual({ kind: "document", documentId: "d2" });
  });

  it("lists each problem once and groups them by document in the order met", () => {
    const issues = [{ code: "invalid_layout", document: "d2" }, { code: "no_file", document: "d1" }, { code: "invalid_layout", document: "d2" }, { code: "envelope_size" }];
    const once = dedupeEnvelopeIssues(issues);
    expect(once).toHaveLength(3);
    expect(groupByDocument(once).map((g) => g.documentId)).toEqual(["d2", "d1", null]);
  });
});
