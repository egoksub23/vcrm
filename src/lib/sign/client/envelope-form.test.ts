import { describe, expect, it } from "vitest";

import { MAX_COPY_RECIPIENTS, seedPeople, type EnvelopeDocLite, type EnvelopePerson } from "../envelopes";
import { MAX_SIGNERS } from "../rules";
import type { SignEnvelopeRow } from "../types";
import {
  addPerson,
  assignedWork,
  countByType,
  dedupeEnvelopeIssues,
  envelopePatch,
  fixFor,
  groupByDocument,
  liveEnvelopeIssues,
  matchTemplateRoles,
  normalizePersonSteps,
  optionsFromEnvelope,
  peopleFromSigners,
  peopleKey,
  peoplePayload,
  personFromContact,
  personHasInput,
  personIsComplete,
  removePerson,
  setPersonRole,
  setPersonType,
  setTemplateMatch,
  templateMatches,
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
    // (the choice to keep a collection private is its own, and is sent when it changes: migration 176)
    expect(envelopePatch(saved, { ...saved, isPrivate: true }, new Date("2026-10-07T00:00:00Z"))).toEqual({ isPrivate: true });
    expect(optionsFromEnvelope({ ...env, is_private: true } as unknown as SignEnvelopeRow).isPrivate).toBe(true);
    expect(optionsFromEnvelope(env).isPrivate).toBe(false);
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
    // the unfinished person who must sign is sent too, flagged, so the server keeps their place; the finished one is not flagged
    expect(payload).toHaveLength(2);
    expect(payload[0].roles).toEqual({ d1: "merchant" });
    expect(payload[0].incomplete).toBeUndefined();
    expect(payload[1]).toMatchObject({ key: "p2", incomplete: true });
    // an unfinished person who receives a copy is not sent at all
    expect(peoplePayload([ali({ key: "c1", type: "copy", roles: {}, email: "" })], docs, true)).toEqual([]);
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

  it("adds a person with no role of their own: only the automatic match gives one (a role label equal to their name)", () => {
    const start = seedPeople(docs);
    expect(start).toHaveLength(2); // merchant, director
    const next = addPerson([start[0]], docs);
    // nothing is handed out just because it is free
    expect(next[1].roles).toEqual({});
    expect(next[1].step).toBe(start[0].step + 1);
    // a name that is a role's label is matched to it
    const named = addPerson([start[0]], docs, "signer", { fullName: "director" });
    expect(named[1].roles).toEqual({ d1: "director" });
  });

  it("keeps a copy's data and a signer's apart, and the people who sign first", () => {
    let list = addPerson([], docs, "signer", { fullName: "Ali", email: "ali@example.com" });
    list = addPerson(list, docs, "copy", { fullName: "Cara", email: "cara@example.com" });
    list = addPerson(list, docs, "signer", { fullName: "Bea", email: "bea@example.com" });
    expect(list.map((p) => p.fullName)).toEqual(["Ali", "Bea", "Cara"]);
    expect(countByType(list)).toEqual({ signers: 2, copies: 1 });
    const payload = peoplePayload(list, [{ id: "up", position: 1, title: "Scan", roles: [], fromTemplate: false }], false);
    expect(payload.map((p) => p.type)).toEqual(["signer", "signer", "copy"]);
    // a copy has no channel, phone, step or roles, and nothing of the screen (the contact) is sent
    expect(payload[2]).toMatchObject({ channel: "email", phone: null, step: 1, roles: {} });
    expect(JSON.stringify(payload)).not.toContain("contactId");
  });

  it("sends every person made on the People screen by email, and keeps a person saved earlier with WhatsApp as they were", () => {
    const upload = [{ id: "up", position: 1, title: "Scan", roles: [], fromTemplate: false }];
    let list = addPerson([], docs, "signer", { fullName: "Ali", email: "ali@example.com", phone: "+60123456789", contactId: "c1" });
    list = updatePerson(list, list[0].key, { email: "ali@vircle.example" });
    list = addPerson(list, docs, "signer", { fullName: "Bea", email: "bea@example.com" });
    expect(list.every((p) => p.channel === "email")).toBe(true);
    expect(peoplePayload(list, upload, false).map((p) => p.channel)).toEqual(["email", "email"]);
    // a person who was saved with WhatsApp (an earlier draft) is not changed behind anyone's back
    const saved = [...list, ali({ key: "wa", fullName: "Wati", email: "wati@example.com", channel: "whatsapp", phone: "+60 12-345 6789" })];
    const payload = peoplePayload(saved, upload, false);
    expect(payload.find((p) => p.key === "wa")).toMatchObject({ channel: "whatsapp", phone: "+60123456789", type: "signer" });
    expect(payload.filter((p) => p.key !== "wa").map((p) => p.channel)).toEqual(["email", "email"]);
    // and still not complete without a number
    expect(personIsComplete(ali({ channel: "whatsapp", phone: "" }), upload)).toBe(false);
  });

  it("saves a person who receives a copy with no signing options, whatever they had before they were switched", () => {
    const upload = [{ id: "up", position: 1, title: "Scan", roles: [], fromTemplate: false }];
    const before = [ali({ key: "p1", channel: "whatsapp", phone: "+60123456789", step: 4, roles: { d1: "merchant" } })];
    const copy = setPersonType(before, "p1", "copy", docs);
    expect(copy[0]).toMatchObject({ type: "copy", channel: "email", phone: "", step: 1, roles: {} });
    // complete with only a name and an email: no phone, no step, no role, no place on a document
    expect(personIsComplete(copy[0], upload)).toBe(true);
    expect(personIsComplete({ ...copy[0], phone: "", step: 0 }, [])).toBe(true);
    expect(peoplePayload(copy, upload, true)).toEqual([{ fullName: "Ali", email: "ali@example.com", phone: null, channel: "email", step: 1, roles: {}, type: "copy", key: "p1" }]);
  });

  it("stops at 20 who must sign and at 10 who receive a copy", () => {
    let list: EnvelopePerson[] = [];
    for (let i = 0; i < MAX_SIGNERS + 3; i++) list = addPerson(list, docs, "signer", { fullName: `S${i}` });
    expect(countByType(list).signers).toBe(MAX_SIGNERS);
    for (let i = 0; i < MAX_COPY_RECIPIENTS + 3; i++) list = addPerson(list, docs, "copy", { fullName: `C${i}` });
    expect(countByType(list).copies).toBe(MAX_COPY_RECIPIENTS);
  });

  it("switches a person to receive a copy (channel, phone, step and roles go) and back (a step of their own)", () => {
    const start = [ali({ channel: "whatsapp", phone: "+60123456789", step: 2, contactId: "c9" }), ali({ key: "p2", fullName: "Bea", email: "bea@example.com", step: 3, roles: {} })];
    const asCopy = setPersonType(start, "p1", "copy", docs);
    expect(asCopy.map((p) => p.key)).toEqual(["p2", "p1"]); // the people who sign stay first
    expect(asCopy[1]).toMatchObject({ type: "copy", channel: "email", phone: "", step: 1, roles: {} });
    const back = setPersonType(asCopy, "p1", "signer", docs);
    expect(back[1]).toMatchObject({ key: "p1", channel: "email", step: 4, contactId: "c9" });
    expect(back[1].type).toBeUndefined();
    // the limit of the other type is respected
    let full: EnvelopePerson[] = [ali()];
    for (let i = 0; i < MAX_COPY_RECIPIENTS; i++) full = addPerson(full, docs, "copy", { fullName: `C${i}` });
    expect(setPersonType(full, "p1", "copy", docs).find((p) => p.key === "p1")?.type).toBeUndefined();
  });

  it("reads the people who receive a copy as people of that type", () => {
    const list = peopleFromSigners([], [{ id: "k1", full_name: "Cara", email: "cara@example.com" }]);
    expect(list).toEqual([expect.objectContaining({ key: "k1", fullName: "Cara", type: "copy", channel: "email" })]);
  });

  it("matches a template's roles to the people who must sign: one role one person, and nobody leaves it free", () => {
    const people = [ali({ roles: {} }), ali({ key: "p2", fullName: "Bea", email: "bea@example.com", roles: {} }), ali({ key: "p3", fullName: "Cara", email: "cara@example.com", type: "copy", roles: {} })];
    const fromTemplate: EnvelopeDocLite[] = [
      { id: "d1", position: 1, title: "Contract", roles: [role("merchant"), role("director")], fromTemplate: true },
      { id: "up", position: 2, title: "Scan", roles: [], fromTemplate: false },
    ];
    // the uploaded file has no line to match
    expect(templateMatches(fromTemplate, people).map((m) => [m.documentId, m.roleKey, m.personKey])).toEqual([["d1", "merchant", null], ["d1", "director", null]]);
    let next = setTemplateMatch(people, "d1", "merchant", "p1");
    next = setTemplateMatch(next, "d1", "director", "p2");
    expect(templateMatches(fromTemplate, next).map((m) => m.personKey)).toEqual(["p1", "p2"]);
    // giving the role to someone else takes it from the first
    next = setTemplateMatch(next, "d1", "merchant", "p2");
    expect(templateMatches(fromTemplate, next).map((m) => m.personKey)).toEqual(["p2", null]);
    expect(next[0].roles).toEqual({});
    expect(setTemplateMatch(next, "d1", "merchant", null).every((p) => p.roles.d1 !== "merchant")).toBe(true);
    // the automatic match uses the role's label
    const labelled: EnvelopeDocLite[] = [{ id: "d1", position: 1, title: "Contract", roles: [{ key: "m", label: "Bea", kind: "signer", color: 0 }], fromTemplate: true }];
    expect(matchTemplateRoles(people, labelled)[1].roles).toEqual({ d1: "m" });
    // and a name typed later is matched too
    expect(updatePerson(people, "p1", { fullName: "bea" }, labelled).filter((p) => p.roles.d1 === "m")).toHaveLength(1);
  });

  it("counts what is assigned to a person: on uploaded files by their key, on a template's documents by the role matched", () => {
    const people = [ali({ key: "pp_aaaaaaaa", roles: { t1: "merchant" } })];
    const work: { id: string; fromTemplate: boolean; fieldCounts: Record<string, number> }[] = [
      { id: "up1", fromTemplate: false, fieldCounts: { pp_aaaaaaaa: 3, pp_other000: 5 } },
      { id: "t1", fromTemplate: true, fieldCounts: { merchant: 2, director: 9 } },
      { id: "up2", fromTemplate: false, fieldCounts: {} },
    ];
    expect(assignedWork(people, "pp_aaaaaaaa", work)).toEqual({ fields: 5, documents: 2 });
    expect(assignedWork(people, "nobody", work)).toEqual({ fields: 0, documents: 0 });
  });

  it("fills a person from a contact: name and email, and the phone when there is one", () => {
    expect(personFromContact({ id: "c1", name: " Dewi ", email: "dewi@example.com", phone: "+60111" })).toEqual({ fullName: "Dewi", email: "dewi@example.com", phone: "+60111", contactId: "c1" });
  });

  it("finds, live, a copy that is also a signer, and too many people who sign on an uploaded file", () => {
    const up: EnvelopeDocLite[] = [{ id: "up", position: 1, title: "Scan", roles: [], fromTemplate: false }];
    const same = [ali({ key: "pp_aaaaaaaa", roles: {} }), ali({ key: "k", type: "copy", roles: {} })];
    expect(liveEnvelopeIssues(up, same, false).map((i) => i.code)).toContain("duplicate_person");
    let seven: EnvelopePerson[] = [];
    for (let i = 0; i < 7; i++) seven = addPerson(seven, up, "signer", { fullName: `S${i}`, email: `s${i}@example.com` });
    expect(liveEnvelopeIssues(up, seven, false).map((i) => i.code)).toContain("too_many_roles");
    expect(liveEnvelopeIssues(up, seven.slice(0, 6), false).map((i) => i.code)).not.toContain("too_many_roles");
    // an uploaded file gives every person a role, so nobody is "not on any document"
    expect(liveEnvelopeIssues(up, [ali({ roles: {} })], false).map((i) => i.code)).not.toContain("person_without_document");
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
    expect(fixFor({ code: "person_without_work", detail: "0" })).toEqual({ kind: "people" });
    expect(fixFor({ code: "too_many_copies", detail: "10" })).toEqual({ kind: "people" });
    // nobody has anything to do on a document: the document's editor is where that is put right
    expect(fixFor({ code: "document_nobody", document: "d2" })).toEqual({ kind: "document", documentId: "d2" });
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
