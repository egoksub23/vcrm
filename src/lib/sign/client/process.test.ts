import { describe, expect, it } from "vitest";

import type { EnvelopePerson } from "../envelopes";
import type { SignCopyRecipientRow, SignDocumentRow, SignSignerRow } from "../types";
import {
  PROCESS_STEPS,
  deriveContact,
  documentCover,
  documentLimits,
  firstContactId,
  firstIncompleteStep,
  nextStep,
  optionIssuesOf,
  previousStep,
  problemTarget,
  processProblems,
  processRights,
  processStatus,
  reachableSteps,
  roleKeyOn,
  sourceFromDraft,
  sourceFromEnvelope,
  startingPeople,
  startingStep,
  summarize,
  tagSingle,
  whatIsLeft,
  type ProcessDoc,
  type ProcessFacts,
} from "./process";
import { baseOptions, person, processDoc, role } from "./process-fixtures";

// The decisions of the one sending workflow, as pure functions: the order of the steps, when each is complete, what is left, where each problem is
// put right, which contact the process links itself to, and what the People step starts from.

const ALI = "pp_aliaaaa1";
const BALA = "pp_balabbbb2";
const people = (...ps: EnvelopePerson[]) => ps;
const ali = (over: Partial<EnvelopePerson> = {}) => person(ALI, "Ali", over);
const bala = (over: Partial<EnvelopePerson> = {}) => person(BALA, "Bala", { step: 2, ...over });
const copyPerson = (over: Partial<EnvelopePerson> = {}) => person("pp_cara0001", "Cara", { type: "copy", ...over });

/** An uploaded file whose roles the people made, with the signature blocks given per person key. */
function upload(n: number, who: EnvelopePerson[], blocks: Record<string, number> = {}, over: Partial<ProcessDoc> = {}): ProcessDoc {
  const signers = who.filter((p) => (p.type ?? "signer") === "signer");
  return processDoc(n, {
    fromTemplate: false,
    roles: signers.map((p, i) => ({ ...role(p.key, p.fullName, i), source: "people" as const })),
    signatureCounts: Object.fromEntries(signers.map((p) => [p.key, blocks[p.key] ?? 0])),
    fieldCounts: Object.fromEntries(signers.map((p) => [p.key, blocks[p.key] ?? 0])),
    rolesNeeded: signers.filter((p) => (blocks[p.key] ?? 0) > 0).map((p) => p.key),
    ...over,
  });
}

const facts = (over: Partial<ProcessFacts> & Pick<ProcessFacts, "docs" | "people">): ProcessFacts => ({ kind: over.docs.length > 1 ? "collection" : "single", ordered: false, optionIssues: [], ...over });

describe("the steps and their order", () => {
  it("are four, in the order of the workflow: documents, people, signature blocks, review and send", () => {
    expect(PROCESS_STEPS).toEqual(["documents", "people", "blocks", "send"]);
    expect(nextStep("documents")).toBe("people");
    expect(nextStep("send")).toBeNull();
    expect(previousStep("people")).toBe("documents");
    expect(previousStep("documents")).toBeNull();
  });

  it("hold one document on its own, or two to six as a collection", () => {
    expect(documentLimits("single")).toEqual({ min: 1, max: 1 });
    expect(documentLimits("collection")).toEqual({ min: 2, max: 6 });
  });
});

describe("when each step is complete", () => {
  it("documents: the right number of them, and a title", () => {
    expect(processStatus(facts({ docs: [], people: [] })).documents).toEqual({ complete: false, reason: "no_documents" });
    expect(processStatus(facts({ kind: "collection", docs: [upload(1, [])], people: [] })).documents).toEqual({ complete: false, reason: "too_few_documents" });
    expect(processStatus(facts({ kind: "single", docs: [upload(1, []), upload(2, [])], people: [] })).documents.reason).toBe("too_few_documents");
    expect(processStatus(facts({ docs: [upload(1, [])], people: [], optionIssues: [{ code: "title_required" }] })).documents).toEqual({ complete: false, reason: "no_title" });
    expect(processStatus(facts({ docs: [upload(1, [])], people: [] })).documents.complete).toBe(true);
    expect(processStatus(facts({ docs: [upload(1, []), upload(2, [])], people: [] })).documents.complete).toBe(true);
  });

  it("people: at least one person who must sign, every person finished, and nothing wrong in the list", () => {
    const d = [upload(1, [ali()])];
    expect(processStatus(facts({ docs: d, people: [] })).people.reason).toBe("no_signer");
    // only a person who receives a copy is not enough
    expect(processStatus(facts({ docs: d, people: people(copyPerson()) })).people.reason).toBe("no_signer");
    // a person with a name and no address is not finished
    expect(processStatus(facts({ docs: d, people: people(ali(), bala({ email: "" })) })).people).toEqual({ complete: false, reason: "unfinished_people", count: 1 });
    // an untouched blank person is not an error yet
    expect(processStatus(facts({ docs: d, people: people(ali(), person("pp_blank001", "", { email: "" })) })).people.complete).toBe(true);
    // the same address twice
    expect(processStatus(facts({ docs: d, people: people(ali(), bala({ email: ali().email })) })).people.reason).toBe("people_problems");
    expect(processStatus(facts({ docs: d, people: people(ali(), bala(), copyPerson()) })).people.complete).toBe(true);
    // a template's role nobody was matched to
    const tpl = processDoc(1, { fromTemplate: true, roles: [role("merchant", "Merchant")], rolesNeeded: ["merchant"] });
    expect(processStatus(facts({ docs: [tpl], people: people(ali()) })).people.complete).toBe(false);
    expect(processStatus(facts({ docs: [tpl], people: people(ali({ roles: { [tpl.id]: "merchant" } })) })).people.complete).toBe(true);
  });

  it("blocks: every document has a signature block AND every person who must sign has one somewhere", () => {
    const who = people(ali(), bala());
    const none = [upload(1, who), upload(2, who)];
    const s0 = processStatus(facts({ docs: none, people: who }));
    expect(s0.blocks).toMatchObject({ complete: false, reason: "no_block_in_document", count: 2 });
    expect(s0.blocks.documents).toEqual([none[0].id, none[1].id]);

    // a block in each document, but only Ali has any: Bala has nothing to sign anywhere
    const aliOnly = [upload(1, who, { [ALI]: 1 }), upload(2, who, { [ALI]: 2 })];
    expect(processStatus(facts({ docs: aliOnly, people: who })).blocks).toEqual({ complete: false, reason: "person_without_block", count: 1 });

    // Bala signs only the second: the first has nothing for them (a note, not a block)
    const split = [upload(1, who, { [ALI]: 1 }), upload(2, who, { [ALI]: 1, [BALA]: 1 })];
    expect(processStatus(facts({ docs: split, people: who })).blocks.complete).toBe(true);
    expect(processStatus(facts({ docs: split, people: who })).send.complete).toBe(true);
  });

  it("blocks: a form without a signature needs its form and a part for each person who fills it in", () => {
    const form = processDoc(1, { mode: "form", fromTemplate: true, hasForm: true, roles: [role("applicant", "Applicant", 0, "filler")], rolesNeeded: ["applicant"], partCounts: { applicant: 2 } });
    const p = ali({ roles: { [form.id]: "applicant" } });
    expect(processStatus(facts({ docs: [form], people: [p] })).blocks.complete).toBe(true);
    expect(processStatus(facts({ docs: [{ ...form, hasForm: false }], people: [p] })).blocks.reason).toBe("no_block_in_document");
    expect(processStatus(facts({ docs: [{ ...form, partCounts: { applicant: 0 } }], people: [p] })).blocks.reason).toBe("person_without_block");
  });

  it("send: complete only when everything before it is, the options are sound and the server has no objection", () => {
    const who = people(ali());
    const docs = [upload(1, who, { [ALI]: 1 })];
    expect(processStatus(facts({ docs, people: who })).send.complete).toBe(true);
    expect(processStatus(facts({ docs, people: who, optionIssues: [{ code: "expiry_past" }] })).send.complete).toBe(false);
    expect(processStatus(facts({ docs, people: who, serverProblems: [{ code: "no_file" }] })).send.complete).toBe(false);
  });
});

describe("which step opens, and where a draft is opened", () => {
  const who = people(ali());
  it("a step opens only when every step before it is complete, and going back is never blocked", () => {
    const s = processStatus(facts({ docs: [upload(1, who)], people: who }));
    const reach = reachableSteps(s);
    expect(reach.documents).toEqual({ open: true, blockedBy: null });
    expect(reach.people.open).toBe(true);
    expect(reach.blocks.open).toBe(true);
    expect(reach.send).toEqual({ open: false, blockedBy: "blocks" });
    const empty = reachableSteps(processStatus(facts({ docs: [upload(1, [])], people: [] })));
    expect(empty.people.open).toBe(true);
    expect(empty.blocks).toEqual({ open: false, blockedBy: "people" });
    expect(empty.send).toEqual({ open: false, blockedBy: "people" });
  });

  it("a draft opens on the first step that is not complete, and on the last when all are", () => {
    expect(firstIncompleteStep(processStatus(facts({ docs: [upload(1, [])], people: [] })))).toBe("people");
    expect(firstIncompleteStep(processStatus(facts({ docs: [upload(1, who)], people: who })))).toBe("blocks");
    expect(firstIncompleteStep(processStatus(facts({ docs: [upload(1, who, { [ALI]: 1 })], people: who })))).toBe("send");
    expect(firstIncompleteStep(processStatus(facts({ docs: [upload(1, who)], people: who, optionIssues: [{ code: "title_required" }] })))).toBe("documents");
  });

  it("?step= is honoured only when that step can be opened", () => {
    const s = processStatus(facts({ docs: [upload(1, who)], people: who }));
    expect(startingStep(s, "people")).toBe("people");
    expect(startingStep(s, "documents")).toBe("documents");
    expect(startingStep(s, "send")).toBe("blocks");
    expect(startingStep(s, "nonsense")).toBe("blocks");
    expect(startingStep(s, null)).toBe("blocks");
  });
});

describe("what is left", () => {
  it("is a short checklist that turns done as the sender goes", () => {
    const who = people(ali(), bala());
    const left = (docs: ProcessDoc[], ps: EnvelopePerson[], over: Partial<ProcessFacts> = {}) => Object.fromEntries(whatIsLeft(facts({ docs, people: ps, ...over })).map((i) => [i.id, i.done]));
    expect(left([upload(1, [])], [])).toEqual({ documents: true, signer: false, people: false, blocks: false, assign: false, options: true });
    expect(left([upload(1, who)], who)).toEqual({ documents: true, signer: true, people: true, blocks: false, assign: false, options: true });
    expect(left([upload(1, who, { [ALI]: 1 })], who)).toEqual({ documents: true, signer: true, people: true, blocks: true, assign: false, options: true });
    expect(left([upload(1, who, { [ALI]: 1, [BALA]: 1 })], who)).toEqual({ documents: true, signer: true, people: true, blocks: true, assign: true, options: true });
    expect(left([upload(1, who, { [ALI]: 1, [BALA]: 1 })], who, { optionIssues: [{ code: "message_long" }] }).options).toBe(false);
  });

  it("names the document to open and how many are left", () => {
    const who = people(ali());
    const docs = [upload(1, who, { [ALI]: 1 }), upload(2, who)];
    const blocks = whatIsLeft(facts({ docs, people: who })).find((i) => i.id === "blocks");
    expect(blocks).toMatchObject({ done: false, step: "blocks", documentId: docs[1].id, count: 1 });
    expect(whatIsLeft(facts({ docs: [upload(1, who)], people: who })).find((i) => i.id === "assign")).toMatchObject({ step: "blocks", count: 1 });
  });
});

describe("a document and the people on it", () => {
  it("says who has a block here, and who has nothing to sign here", () => {
    const who = people(ali(), bala());
    const cover = documentCover(upload(1, who, { [ALI]: 3 }), who);
    expect(cover.blocks).toBe(3);
    expect(cover.state).toBe("partial");
    expect(cover.people.map((p) => [p.name, p.blocks, p.covered])).toEqual([["Ali", 3, true], ["Bala", 0, false]]);
    expect(documentCover(upload(1, who, { [ALI]: 1, [BALA]: 1 }), who).state).toBe("ready");
    expect(documentCover(upload(1, who), who).state).toBe("empty");
  });

  it("lists, on a template's document, only the people matched to one of its roles", () => {
    const tpl = processDoc(1, { fromTemplate: true, roles: [role("merchant", "Merchant")], signatureCounts: { merchant: 1 } });
    const who = people(ali({ roles: { [tpl.id]: "merchant" } }), bala());
    expect(documentCover(tpl, who).people.map((p) => p.name)).toEqual(["Ali"]);
    expect(documentCover(tpl, who).state).toBe("ready");
    expect(roleKeyOn(who[0], tpl)).toBe("merchant");
    expect(roleKeyOn(who[1], tpl)).toBe("");
    expect(roleKeyOn(who[1], upload(2, who))).toBe(BALA);
  });

  it("a person's colour is their place among the people who must sign, whoever else is listed", () => {
    const who = people(copyPerson(), ali(), bala());
    expect(documentCover(upload(1, who, { [ALI]: 1 }), who).people.map((p) => p.color)).toEqual([0, 1]);
  });
});

describe("where a problem is put right", () => {
  it("sends the options to the last step and the title to the first", () => {
    expect(problemTarget({ code: "title_required" })).toEqual({ step: "documents" });
    for (const code of ["message_long", "expiry_past", "reminders_bad"]) expect(problemTarget({ code })).toEqual({ step: "send" });
    expect(problemTarget({ code: "no_file", document: "d1" })).toEqual({ step: "documents", documentId: "d1" });
  });

  it("sends the people's problems to People, with or without a document named", () => {
    for (const code of ["no_signer", "signer_email", "signer_name", "duplicate_person", "person_without_work", "role_two_people", "role_without_person", "no_roles", "too_many_copies"]) {
      expect(problemTarget({ code, document: "d1" })).toEqual({ step: "people" });
    }
  });

  it("sends a document's own problems to its editor", () => {
    expect(problemTarget({ code: "signer_without_signature", role: ALI, document: "d1" })).toEqual({ step: "blocks", documentId: "d1" });
    expect(problemTarget({ code: "document_nobody", document: "d2" })).toEqual({ step: "blocks", documentId: "d2" });
    expect(problemTarget({ code: "field_outside_page", field: "f1", document: "d1" })).toEqual({ step: "blocks", documentId: "d1" });
  });

  it("tags a document on its own's problems with the document, so the same mapping reads them", () => {
    const tagged = tagSingle([{ code: "signer_without_signature", role: ALI }, { code: "no_signer" }, { code: "x", document: "other" }], "d1");
    expect(tagged.map((i) => i.document)).toEqual(["d1", "d1", "other"]);
    expect(problemTarget(tagged[0])).toEqual({ step: "blocks", documentId: "d1" });
    expect(tagSingle([{ code: "a" }], undefined)).toEqual([{ code: "a" }]);
  });
});

describe("everything that stands between the process and Send", () => {
  it("is the options as typed, what is wrong with the people on screen, and what the server said, each once", () => {
    const who = people(ali(), bala({ email: ali().email }));
    const docs = [upload(1, who, { [ALI]: 1, [BALA]: 1 })];
    const codes = (f: ProcessFacts) => processProblems(f).map((p) => p.code);
    const base = facts({ docs, people: who, optionIssues: [{ code: "expiry_past" }], serverProblems: [{ code: "duplicate_person", detail: "1" }, { code: "no_file" }] });
    // the duplicate is found here and by the server: shown once
    expect(codes(base).filter((c) => c === "duplicate_person")).toHaveLength(1);
    expect(codes(base)).toContain("expiry_past");
    expect(codes(base)).toContain("no_file");
  });

  it("tags the server's problems of a document on its own with it, and leaves a collection's as they come", () => {
    const docs = [upload(1, people(ali()))];
    expect(processProblems(facts({ docs, people: people(ali()), serverProblems: [{ code: "signer_without_signature", role: ALI }] })).find((p) => p.code === "signer_without_signature")?.document).toBe(docs[0].id);
    const two = [upload(1, people(ali())), upload(2, people(ali()))];
    expect(processProblems(facts({ docs: two, people: people(ali()), serverProblems: [{ code: "document_nobody", document: two[1].id }] })).find((p) => p.code === "document_nobody")?.document).toBe(two[1].id);
  });

  it("reads the options as typed with the codes the server uses", () => {
    expect(optionIssuesOf(baseOptions, new Date("2026-10-06T08:00:00Z"))).toEqual([]);
    expect(optionIssuesOf({ ...baseOptions, title: "  " }, new Date("2026-10-06T08:00:00Z"))).toEqual([{ code: "title_required" }]);
    expect(optionIssuesOf({ ...baseOptions, reminderText: "3, x", expiryDate: "2026-10-01", message: "m".repeat(2001) }, new Date("2026-10-06T08:00:00Z")).map((i) => i.code).sort()).toEqual(["expiry_past", "message_long", "reminders_bad"]);
  });
});

describe("the contact the process links itself to", () => {
  const picked = (contactId: string | null, over: Partial<EnvelopePerson> = {}) => ali({ contactId, ...over });

  it("is the contact of the first person who must sign who was picked from the contacts", () => {
    expect(firstContactId([ali(), bala({ contactId: "c-bala" })])).toBe("c-bala");
    expect(firstContactId([bala({ contactId: "c-bala" }), picked("c-ali")])).toBe("c-bala");
    // a person who receives a copy never links it
    expect(firstContactId([copyPerson({ contactId: "c-cara" }), ali()])).toBeNull();
    expect(firstContactId([])).toBeNull();
  });

  it("follows the people while the process made the link itself, and goes when that person does", () => {
    expect(deriveContact({ people: [picked("c-ali")], current: null, lastDerived: null, manual: false })).toBe("c-ali");
    // the first person changes: the link follows
    expect(deriveContact({ people: [picked("c-bala")], current: "c-ali", lastDerived: "c-ali", manual: false })).toBe("c-bala");
    // nobody is from the contacts any more: a link the process made goes
    expect(deriveContact({ people: [ali()], current: "c-ali", lastDerived: "c-ali", manual: false })).toBeNull();
  });

  it("never replaces a contact the sender chose or removed, or one the process already had", () => {
    expect(deriveContact({ people: [picked("c-ali")], current: "c-page", lastDerived: null, manual: false })).toBe("c-page");
    expect(deriveContact({ people: [picked("c-ali")], current: "c-chosen", lastDerived: "c-ali", manual: false })).toBe("c-chosen");
    expect(deriveContact({ people: [picked("c-ali")], current: null, lastDerived: null, manual: true })).toBeNull();
    expect(deriveContact({ people: [picked("c-ali")], current: "c-chosen", lastDerived: null, manual: true })).toBe("c-chosen");
    // a contact from the page stays when the people have none
    expect(deriveContact({ people: [ali()], current: "c-page", lastDerived: null, manual: false })).toBe("c-page");
  });
});

describe("what the People step starts from", () => {
  const signerRow = (over: Partial<SignSignerRow>): SignSignerRow =>
    ({ id: "s1", account_id: "a", document_id: "00000001-0000-4000-8000-000000000000", role_key: ALI, kind: "signer", full_name: "Ali", email: "ali@example.com", phone: null, channel: "email", order_no: 1, party_id: null, part_keys: null, ...over }) as unknown as SignSignerRow;
  const copyRow = (): SignCopyRecipientRow => ({ id: "cp1", account_id: "a", document_id: "x", envelope_id: null, full_name: "Cara", email: "cara@example.com", notified_at: null, created_by: null, created_at: "" }) as SignCopyRecipientRow;

  it("is what was saved: the people who must sign in step order, then the people who receive a copy", () => {
    const doc = upload(1, people(ali()));
    const { people: list, saved } = startingPeople([doc], [signerRow({})], [copyRow()]);
    expect(saved).toHaveLength(2);
    expect(list.map((p) => [p.fullName, p.type ?? "signer"])).toEqual([["Ali", "signer"], ["Cara", "copy"]]);
    // a person who has their own `pp_` role keeps it as their key
    expect(list[0].key).toBe(ALI);
  });

  it("keys a person by the older role they hold on an uploaded file, so its blocks stay with them", () => {
    const doc = processDoc(1, { fromTemplate: false, roles: [role("signer1", "Signer")], fieldCounts: { signer1: 2 }, signatureCounts: { signer1: 2 } });
    const { people: list } = startingPeople([doc], [signerRow({ role_key: "signer1", document_id: doc.id })], []);
    expect(list[0].key).toBe("signer1");
    expect(roleKeyOn(list[0], doc)).toBe("signer1");
  });

  it("starts from the roles that are there when nothing is saved: a template's, and an uploaded file's older ones that have blocks", () => {
    const tpl = processDoc(1, { fromTemplate: true, roles: [role("merchant", "Merchant"), role("director", "Director", 1)] });
    const seeded = startingPeople([tpl], [], []).people;
    expect(seeded.map((p) => p.roles[tpl.id]).sort()).toEqual(["director", "merchant"]);
    const older = processDoc(2, { fromTemplate: false, roles: [role("signer1", "Signer"), role("unused", "Unused", 1)], fieldCounts: { signer1: 1, unused: 0 } });
    const fromOlder = startingPeople([older], [], []).people;
    expect(fromOlder.map((p) => [p.key, p.fullName, p.email])).toEqual([["signer1", "Signer", ""]]);
    // a plain uploaded file has nothing to start from
    expect(startingPeople([upload(3, [])], [], []).people).toEqual([]);
  });
});

describe("what the screens read of a document and of a collection", () => {
  const row = (over: Partial<SignDocumentRow> = {}): SignDocumentRow =>
    ({ id: "d1", reference: "SGN-1", title: "Lease", status: "draft", mode: "sign", template_version_id: null, page_count: 3, base_path: "p", roles_snapshot: [], fields_snapshot: [], form_snapshot: null, category_id: null, contact_id: "c1", ticket_id: null, deal_id: null, sign_in_order: false, code_required: false, allow_forwarding: false, locale: "en", message: null, expires_at: null, reminder_days: [], completed_at: null, final_path: null, ...over }) as unknown as SignDocumentRow;

  it("a document on its own is a process of one document", () => {
    const src = sourceFromDraft({ document: row(), signers: [], problems: [{ code: "no_signer" }] });
    expect(src).toMatchObject({ kind: "single", id: "d1", reference: "SGN-1", serverProblems: [{ code: "no_signer" }], headroom: null });
    expect(src.docs.map((d) => [d.id, d.title, d.pageCount, d.fromTemplate])).toEqual([["d1", "Lease", 3, false]]);
    expect(src.options).toMatchObject({ title: "Lease", contactId: "c1" });
    expect(src.copies).toEqual([]);
  });

  it("counts the signature blocks (a signature or initials) of each role, for the cards and the summary", () => {
    const fields = [
      { key: "a", type: "signature", role: "r1", page: 0, x: 0, y: 0, w: 0.2, h: 0.05, required: true },
      { key: "b", type: "initials", role: "r1", page: 0, x: 0, y: 0.2, w: 0.1, h: 0.05, required: true },
      { key: "c", type: "text", role: "r1", page: 0, x: 0, y: 0.4, w: 0.2, h: 0.03, required: true },
    ];
    const src = sourceFromDraft({ document: row({ roles_snapshot: [role("r1", "Ali")], fields_snapshot: fields as never }), signers: [], problems: [] });
    expect(src.docs[0].signatureCounts).toEqual({ r1: 2 });
    expect(src.docs[0].fieldCounts).toEqual({ r1: 3 });
  });

  it("a collection reads its documents and the links of its documents", () => {
    const docs = [processDoc(1), processDoc(2)];
    const env = { id: "e1", reference: "ENV-1", title: "Onboarding", contact_id: null, message: null, locale: "en", sign_in_order: false, code_required: false, reminder_days: [], expires_at: null } as never;
    const src = sourceFromEnvelope({ envelope: env, documents: docs, signers: [], problems: [], headroom: null, links: { ticketId: "t1", dealId: null } });
    expect(src).toMatchObject({ kind: "collection", id: "e1", docs });
    expect(src.options).toMatchObject({ title: "Onboarding", ticketId: "t1", dealId: null });
  });
});

describe("the summary", () => {
  it("lists the documents with their blocks and the people with theirs, leaving out a person not started", () => {
    const who = people(ali(), bala(), copyPerson(), person("pp_blank001", "", { email: "" }));
    const docs = [upload(1, who, { [ALI]: 2 }), upload(2, who, { [ALI]: 1, [BALA]: 1 })];
    const s = summarize(facts({ docs, people: who }), "Onboarding");
    expect(s.title).toBe("Onboarding");
    expect(s.documents.map((d) => [d.title, d.blocks, d.state])).toEqual([["Document 1", 2, "partial"], ["Document 2", 2, "ready"]]);
    expect(s.people.map((p) => [p.name, p.type, p.blocks])).toEqual([["Ali", "signer", 3], ["Bala", "signer", 1], ["Cara", "copy", 0]]);
    expect(s.counts).toEqual({ signers: 2, copies: 1 });
    expect(s.left.every((i) => i.done)).toBe(true);
  });
});

// migration 176: who edits a draft, and who changes whether it is private
describe("who may edit a draft", () => {
  const rights = (over: Partial<Parameters<typeof processRights>[0]>) => processRights({ mayHold: true, isAdmin: false, isUploader: false, isPrivate: false, ...over });

  it("is whoever may send, for a draft that is not private; only the uploader or an admin may make it private", () => {
    expect(rights({})).toEqual({ canSend: true, canChangePrivacy: false });
    expect(rights({ isUploader: true })).toEqual({ canSend: true, canChangePrivacy: true });
    expect(rights({ isAdmin: true })).toEqual({ canSend: true, canChangePrivacy: true });
  });

  it("is the uploader and the admins alone for a private draft: anyone else (a Halo user named on it) reads it", () => {
    expect(rights({ isPrivate: true })).toEqual({ canSend: false, canChangePrivacy: false });
    expect(rights({ isPrivate: true, isUploader: true })).toEqual({ canSend: true, canChangePrivacy: true });
    expect(rights({ isPrivate: true, isAdmin: true })).toEqual({ canSend: true, canChangePrivacy: true });
  });

  it("is nobody's without the permission to send, even the uploader of a private draft", () => {
    for (const isPrivate of [false, true]) expect(rights({ mayHold: false, isUploader: true, isAdmin: true, isPrivate })).toEqual({ canSend: false, canChangePrivacy: false });
  });

  it("reads the uploader from the process source (a document's or a collection's created_by)", () => {
    const doc = { id: "d1", account_id: "a", title: "T", status: "draft", created_by: "u1", is_private: true, fields_snapshot: [], roles_snapshot: [], base_path: "p", page_count: 1, reference: "SGN-1", mode: "sign" } as unknown as SignDocumentRow;
    const source = sourceFromDraft({ document: doc, signers: [], problems: [] });
    expect(source.createdBy).toBe("u1");
    expect(source.options.isPrivate).toBe(true);
  });
});
