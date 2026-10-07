// ============================================================
// Doc Sign, browser side: the ONE sending workflow, for a document on its own and for a document collection. Four steps, in this order:
//
//   1. Documents       upload the file(s) and/or pick templates, and title the process
//   2. People          everyone who takes part: a name, an email and a type ("Must sign" or "Receives a copy")
//   3. Signature blocks  open each document and place the blocks, each assigned to a person who must sign
//   4. Review and send   the options, the optional links, what is left, and Send
//
// This file holds the decisions of that workflow as pure functions over plain data, so the order of the steps, when each is complete, what is
// still left to do, where each problem is put right, which contact the process links itself to, and what the people step starts from are all
// tested without a screen. A document on its own is read as a collection of one (the same people model, the same roles made from the people).
// ============================================================

import { SENDER_ROLE } from "../rules";
import { MAX_COPY_RECIPIENTS, ENVELOPE_MAX_DOCUMENTS, ENVELOPE_MIN_DOCUMENTS, isCopy, isSigner, seedPeople, type EnvelopeDocLite, type EnvelopePerson, type EnvelopeDocumentSummary } from "../envelopes";
import { summarizeDocument } from "../envelopes/summary";
import type { SignCopyRecipientRow, SignDocumentRow, SignEnvelopeRow, SignSignerRow } from "../types";
import type { SignIssue } from "./api";
import { optionsFlags, optionsFromDocument, type DraftOptions } from "./draft-options";
import { fixFor, liveEnvelopeIssues, matchTemplateRoles, optionsFromEnvelope, peopleFromSigners, personHasInput, personIsComplete } from "./envelope-form";

/** What the options as typed would be refused for, as problems (the same codes the server uses). */
export function optionIssuesOf(options: DraftOptions, now: Date): SignIssue[] {
  const flags = optionsFlags(options, now);
  return [...(flags.title ? [{ code: "title_required" }] : []), ...(flags.message ? [{ code: "message_long" }] : []), ...(flags.expiryPast ? [{ code: "expiry_past" }] : []), ...(flags.reminders ? [{ code: "reminders_bad" }] : [])];
}

// ---- who may edit a draft (migration 176) ---------------------------------------------------------------------

/**
 * What the reader may do with a draft process. Whoever may send (`sign.send`) edits it, except that a PRIVATE draft is edited by its uploader or an
 * admin alone (a Halo user named on it reads it), and only the uploader or an admin can change whether it is private. The server holds the same rule;
 * this is so the screens do not offer what would be refused.
 */
export function processRights(a: { mayHold: boolean; isAdmin: boolean; isUploader: boolean; isPrivate: boolean }): { canSend: boolean; canChangePrivacy: boolean } {
  const canChangePrivacy = a.mayHold && (a.isAdmin || a.isUploader);
  return { canChangePrivacy, canSend: a.mayHold && (!a.isPrivate || canChangePrivacy) };
}

// ---- the steps ------------------------------------------------------------------------------------

export const PROCESS_STEPS = ["documents", "people", "blocks", "send"] as const;
export type StepId = (typeof PROCESS_STEPS)[number];
export type ProcessKind = "single" | "collection";

/** A document of the process as the steps read it: no fields, no form, only what they say about it. */
export type ProcessDoc = EnvelopeDocumentSummary;

export const isStepId = (v: unknown): v is StepId => typeof v === "string" && (PROCESS_STEPS as readonly string[]).includes(v);

/** How many documents the process holds: one on its own, two to six as a collection. */
export const documentLimits = (kind: ProcessKind): { min: number; max: number } => (kind === "single" ? { min: 1, max: 1 } : { min: ENVELOPE_MIN_DOCUMENTS, max: ENVELOPE_MAX_DOCUMENTS });

/** What the People step reads of the documents (whether each came from a template decides whether it has roles to match). */
export const liteDocs = (docs: readonly ProcessDoc[]): EnvelopeDocLite[] => docs.map((d) => ({ id: d.id, position: d.position, title: d.title, roles: d.roles, mode: d.mode, needed: d.rolesNeeded, fromTemplate: d.fromTemplate }));

/** The role a person has on a document: their own key on an uploaded file (it took its role from them), the matched template role otherwise. "" when none. */
export function roleKeyOn(person: EnvelopePerson, doc: Pick<ProcessDoc, "id" | "fromTemplate">): string {
  return doc.fromTemplate ? (person.roles[doc.id] ?? "") : person.key;
}

// ---- what the screens read of a process ---------------------------------------------------------------------------

export interface ProcessHeadroom {
  limit: number | null;
  used: number;
  remaining: number | null;
  needed: number;
  fits: boolean;
}

/** What the sender's screens read of a process (a document on its own, or a collection). */
export interface ProcessSource {
  kind: ProcessKind;
  id: string;
  reference: string | null;
  docs: ProcessDoc[];
  signers: SignSignerRow[];
  copies: SignCopyRecipientRow[];
  /** The options as saved. */
  options: DraftOptions;
  /** What the server says stands between the process and Send (each may name its document). */
  serverProblems: SignIssue[];
  headroom: ProcessHeadroom | null;
  /** A document on its own: its row (the form it carries, its category). */
  document?: SignDocumentRow;
  /** Who uploaded it (the document's, or the collection's): with the workspace's admins, the only people who may change whether it is private. */
  createdBy?: string | null;
}

/** A document on its own, read as a process of one document. */
export function sourceFromDraft(data: { document: SignDocumentRow; signers: SignSignerRow[]; copies?: SignCopyRecipientRow[]; problems: SignIssue[] }): ProcessSource {
  const doc = data.document;
  return { kind: "single", id: doc.id, reference: doc.reference, docs: [summarizeDocument(doc)], signers: data.signers, copies: data.copies ?? [], options: optionsFromDocument(doc), serverProblems: data.problems, headroom: null, document: doc, createdBy: doc.created_by };
}

/** A document collection, read as a process of its documents. */
export function sourceFromEnvelope(data: { envelope: SignEnvelopeRow; documents: ProcessDoc[]; signers: SignSignerRow[]; copies?: SignCopyRecipientRow[]; problems: SignIssue[]; headroom: ProcessHeadroom | null; links: { ticketId: string | null; dealId: string | null } }): ProcessSource {
  const env = data.envelope;
  return { kind: "collection", id: env.id, reference: env.reference, docs: data.documents, signers: data.signers, copies: data.copies ?? [], options: optionsFromEnvelope(env, data.links), serverProblems: data.problems, headroom: data.headroom, createdBy: env.created_by };
}

// ---- what the People step starts from -----------------------------------------------------------------

/**
 * One person for each role of an uploaded document that has fields and was not made from a person (a role from before roles were made from
 * people), keyed by that role so the fields stay with them. Unfinished (no address yet): the sender completes them on the People step.
 */
function peopleFromOlderRoles(doc: ProcessDoc): EnvelopePerson[] {
  return doc.roles
    .filter((r) => r.source !== "people" && r.key !== SENDER_ROLE && (doc.fieldCounts[r.key] ?? 0) > 0 && r.kind === "signer")
    .slice(0, 6)
    .map((r, i) => ({ key: r.key, fullName: r.label, email: "", phone: "", channel: "email" as const, step: i + 1, roles: { [doc.id]: r.key } }));
}

/**
 * The people as the screen starts them: what the server holds (the people who must sign, in step order, then the people who receive a copy);
 * when nothing is saved, one person for each role of a template's document (or each older role of an uploaded one); then the template roles
 * matched where they fit. For an uploaded document a saved person is keyed by the role they hold, so an older role keeps its fields when
 * the person is saved again.
 */
export function startingPeople(docs: readonly ProcessDoc[], signers: readonly SignSignerRow[], copies: readonly SignCopyRecipientRow[]): { saved: EnvelopePerson[]; people: EnvelopePerson[] } {
  const lite = liteDocs(docs);
  const upload = docs.filter((d) => !d.fromTemplate);
  const taken = new Set<string>();
  const saved = peopleFromSigners(signers, copies).map((p) => {
    if (isCopy(p)) return p;
    // the role this person holds on an uploaded document is theirs: their key (a `pp_` key already is; an older role's key is kept too, once:
    // two people on one older role cannot both be it)
    const own = upload.map((d) => p.roles[d.id]).find((k) => !!k && !k.startsWith("pp_") && !taken.has(k) && upload.some((d) => d.roles.some((r) => r.key === k)));
    if (own) taken.add(own);
    return own ? { ...p, key: own } : p;
  });
  const seeded = saved.length > 0 ? saved : [...(docs.some((d) => d.fromTemplate) ? seedPeople(lite) : []), ...upload.flatMap(peopleFromOlderRoles)];
  return { saved, people: matchTemplateRoles(seeded, lite) };
}

// ---- how much each document has, per person -------------------------------------------------------------

/** One person who must sign, on one document: how many signature blocks (and parts of its form) are theirs. */
export interface PersonCover {
  key: string;
  /** As typed ("" when not yet). */
  name: string;
  color: number;
  blocks: number;
  parts: number;
  /** Something of theirs on this document: a signature block, or (a form without a signature) a part of the form. */
  covered: boolean;
}

export type CoverState = "empty" | "partial" | "ready";

export interface DocCover {
  doc: ProcessDoc;
  /** A form without a signature: nothing is placed on a page, the form is the work. */
  formOnly: boolean;
  /** Signature blocks (a signature or initials) on the document, for anyone. */
  blocks: number;
  /** The people who must sign who have a place on this document (an uploaded file gives every person one; a template's roles are matched). */
  people: PersonCover[];
  /** `empty`: nothing to sign yet; `partial`: some of its people have nothing here; `ready`: every one of them has. */
  state: CoverState;
}

/** The people who have been started (something is typed): a row nobody has typed in yet is not a person, and is neither checked nor saved. */
export const typedPeople = (people: readonly EnvelopePerson[]): EnvelopePerson[] => people.filter(personHasInput);

/** The colour slot of a person who must sign (their place in the list, as the roles the people make are coloured). */
export const personColor = (people: readonly EnvelopePerson[], key: string): number => Math.max(0, typedPeople(people).filter(isSigner).findIndex((p) => p.key === key)) % 6;

export function documentCover(doc: ProcessDoc, people: readonly EnvelopePerson[]): DocCover {
  const signers = typedPeople(people).filter(isSigner);
  const formOnly = doc.mode === "form";
  const mine = signers
    .filter((p) => !doc.fromTemplate || !!p.roles[doc.id])
    .map((p): PersonCover => {
      const role = roleKeyOn(p, doc);
      const blocks = role ? (doc.signatureCounts[role] ?? 0) : 0;
      const parts = role ? (doc.partCounts[role] ?? 0) : 0;
      return { key: p.key, name: p.fullName.trim(), color: doc.roles.find((r) => r.key === role)?.color ?? personColor(people, p.key), blocks, parts, covered: formOnly ? parts > 0 : blocks > 0 };
    });
  const blocks = Object.values(doc.signatureCounts).reduce((n, c) => n + c, 0);
  const worked = formOnly ? doc.hasForm : blocks > 0;
  const state: CoverState = !worked ? "empty" : mine.length > 0 && mine.every((p) => p.covered) ? "ready" : "partial";
  return { doc, formOnly, blocks, people: mine, state };
}

/** Does a person have something to sign or fill in on any of the documents. */
export const personHasWork = (covers: readonly DocCover[], key: string): boolean => covers.some((c) => c.people.some((p) => p.key === key && p.covered));

// ---- the status of each step -----------------------------------------------------------------------------

export interface ProcessFacts {
  kind: ProcessKind;
  docs: readonly ProcessDoc[];
  people: readonly EnvelopePerson[];
  ordered: boolean;
  /** What the options as typed would be refused for (`title_required`, `message_long`, `expiry_past`, `reminders_bad`). */
  optionIssues: readonly SignIssue[];
  /** What the server last said stands between the process and Send (each issue may name its document). */
  serverProblems?: readonly SignIssue[];
}

/** Why a step cannot be left or reached yet; each has its words under `Sign.process.blocked`. */
export type BlockReason = "no_documents" | "too_few_documents" | "no_title" | "no_signer" | "unfinished_people" | "people_problems" | "no_block_in_document" | "person_without_block";

export interface StepStatus {
  complete: boolean;
  reason?: BlockReason;
  /** The documents (by id) a reason is about. */
  documents?: string[];
  /** A number a reason is about (the people not finished, the people without a block). */
  count?: number;
}

export type ProcessStatus = Record<StepId, StepStatus>;

/** The people who still need something typed (a name, an address, a phone for WhatsApp, a role to match). */
export function unfinishedPeople(people: readonly EnvelopePerson[], docs: readonly EnvelopeDocLite[]): EnvelopePerson[] {
  return people.filter((p) => personHasInput(p) && !personIsComplete(p, docs));
}

const titleOk = (f: ProcessFacts): boolean => !f.optionIssues.some((i) => i.code === "title_required");
const optionsOk = (f: ProcessFacts): boolean => f.optionIssues.length === 0;

export function processStatus(facts: ProcessFacts): ProcessStatus {
  const f = { ...facts, people: typedPeople(facts.people) };
  const lite = liteDocs(f.docs);
  const { min, max } = documentLimits(f.kind);

  const documents: StepStatus = f.docs.length === 0 ? { complete: false, reason: "no_documents" } : f.docs.length < min || f.docs.length > max ? { complete: false, reason: "too_few_documents" } : !titleOk(f) ? { complete: false, reason: "no_title" } : { complete: true };

  const signers = f.people.filter(isSigner);
  const unfinished = unfinishedPeople(f.people, lite);
  const issues = liveEnvelopeIssues(lite, f.people, f.ordered);
  const people: StepStatus =
    signers.length === 0 ? { complete: false, reason: "no_signer" } : unfinished.length > 0 ? { complete: false, reason: "unfinished_people", count: unfinished.length } : issues.length > 0 ? { complete: false, reason: "people_problems", count: issues.length } : { complete: true };

  const covers = f.docs.map((d) => documentCover(d, f.people));
  const emptyDocs = covers.filter((c) => c.state === "empty").map((c) => c.doc.id);
  const idle = signers.filter((p) => !personHasWork(covers, p.key));
  const blocks: StepStatus =
    f.docs.length === 0 || signers.length === 0
      ? { complete: false, reason: signers.length === 0 ? "no_signer" : "no_documents" }
      : emptyDocs.length > 0
        ? { complete: false, reason: "no_block_in_document", documents: emptyDocs, count: emptyDocs.length }
        : idle.length > 0
          ? { complete: false, reason: "person_without_block", count: idle.length }
          : { complete: true };

  const problems = processProblems(f);
  const send: StepStatus = { complete: documents.complete && people.complete && blocks.complete && optionsOk(f) && problems.length === 0 };
  return { documents, people, blocks, send };
}

/** Which steps can be opened: a step is open when every step before it is complete; going back is always free. */
export function reachableSteps(status: ProcessStatus): Record<StepId, { open: boolean; blockedBy: StepId | null }> {
  const out = {} as Record<StepId, { open: boolean; blockedBy: StepId | null }>;
  let blocker: StepId | null = null;
  for (const id of PROCESS_STEPS) {
    out[id] = { open: blocker === null, blockedBy: blocker };
    if (blocker === null && id !== "send" && !status[id].complete) blocker = id;
  }
  return out;
}

/** The first step that is not complete (where a person who comes back to a draft lands); "send" when all of the others are. */
export function firstIncompleteStep(status: ProcessStatus): StepId {
  return PROCESS_STEPS.find((id) => id !== "send" && !status[id].complete) ?? "send";
}

/** The step to open: the one asked for (`?step=`) when it can be opened, otherwise the first that is not complete. */
export function startingStep(status: ProcessStatus, asked: string | null | undefined): StepId {
  const reach = reachableSteps(status);
  return isStepId(asked) && reach[asked].open ? asked : firstIncompleteStep(status);
}

export const nextStep = (step: StepId): StepId | null => PROCESS_STEPS[PROCESS_STEPS.indexOf(step) + 1] ?? null;
export const previousStep = (step: StepId): StepId | null => PROCESS_STEPS[PROCESS_STEPS.indexOf(step) - 1] ?? null;

// ---- what is left -------------------------------------------------------------------------------------------

export interface LeftItem {
  /** The words are `Sign.process.left.<id>`. */
  id: "documents" | "signer" | "people" | "blocks" | "assign" | "options";
  done: boolean;
  /** The step that puts it right. */
  step: StepId;
  /** The document to open, when it is about one. */
  documentId?: string;
  count?: number;
}

/** A short checklist of what stands between the process and Send; each item turns done as the sender goes. */
export function whatIsLeft(facts: ProcessFacts): LeftItem[] {
  const f = { ...facts, people: typedPeople(facts.people) };
  const status = processStatus(f);
  const lite = liteDocs(f.docs);
  const covers = f.docs.map((d) => documentCover(d, f.people));
  const signers = f.people.filter(isSigner);
  const { min, max } = documentLimits(f.kind);
  const emptyDocs = covers.filter((c) => c.state === "empty");
  const idle = signers.filter((p) => !personHasWork(covers, p.key));
  const unfinished = unfinishedPeople(f.people, lite);
  return [
    { id: "documents", done: f.docs.length >= min && f.docs.length <= max && titleOk(f), step: "documents" },
    { id: "signer", done: signers.length > 0, step: "people" },
    { id: "people", done: signers.length > 0 && unfinished.length === 0 && status.people.complete, step: "people", count: unfinished.length },
    { id: "blocks", done: f.docs.length > 0 && emptyDocs.length === 0, step: "blocks", documentId: emptyDocs[0]?.doc.id, count: emptyDocs.length },
    { id: "assign", done: signers.length > 0 && idle.length === 0, step: "blocks", count: idle.length },
    { id: "options", done: optionsOk(f), step: "send" },
  ];
}

// ---- the problems and where each is put right ---------------------------------------------------------------

/** Problems with a document on its own come without a document: they are about the one document. */
export const tagSingle = (issues: readonly SignIssue[], documentId: string | undefined): SignIssue[] => issues.map((i) => (i.document || !documentId ? i : { ...i, document: documentId }));

const OPTION_CODES = new Set(["title_required", "message_long", "expiry_past", "reminders_bad"]);
/** What the People step puts right that the shared fix does not already say. */
const PEOPLE_EXTRA = new Set(["no_roles", "signer_role_missing"]);

/** Where a problem is put right: a step, and the document to open when it is in one. */
export interface ProblemTarget {
  step: StepId;
  documentId?: string;
}

export function problemTarget(issue: SignIssue): ProblemTarget {
  if (issue.code === "title_required") return { step: "documents" };
  if (OPTION_CODES.has(issue.code)) return { step: "send" };
  if (issue.code === "no_file") return { step: "documents", ...(issue.document ? { documentId: issue.document } : {}) };
  if (PEOPLE_EXTRA.has(issue.code)) return { step: "people" };
  const fix = fixFor(issue);
  if (fix.kind === "options") return { step: "send" };
  if (fix.kind === "people") return { step: "people" };
  return { step: "blocks", documentId: fix.documentId };
}

const dedupe = (issues: readonly SignIssue[], ignoreDocument = false): SignIssue[] => {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.code}|${ignoreDocument ? "" : (i.document ?? "")}|${i.field ?? ""}|${i.role ?? ""}|${i.detail ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/**
 * Everything that stands between the process and Send: what the options as typed would be refused for, what is wrong with the people on screen,
 * and what the server last said (it reads what is saved, which may be a moment behind the screen), each once. The server's problems of a
 * document on its own come without a document; they are tagged with it.
 */
export function processProblems(facts: ProcessFacts): SignIssue[] {
  const f = { ...facts, people: typedPeople(facts.people) };
  const live = liveEnvelopeIssues(liteDocs(f.docs), f.people, f.ordered);
  // a document on its own has one document: everything is about it, whether it was found here or by the server
  if (f.kind === "single") return tagSingle(dedupe([...f.optionIssues, ...live, ...(f.serverProblems ?? [])], true), f.docs[0]?.id);
  return dedupe([...f.optionIssues, ...live, ...(f.serverProblems ?? [])]);
}

// ---- the contact the process links itself to ---------------------------------------------------------------------

/** The contact of the first person who must sign who was picked from the contacts (null when none was). */
export function firstContactId(people: readonly EnvelopePerson[]): string | null {
  return people.filter(isSigner).find((p) => !!p.contactId)?.contactId ?? null;
}

/**
 * The contact the process is linked to as the people change. It links itself to the contact of the first person who must sign who was picked
 * from the contacts. A contact the sender chose or removed (`manual`), or one the process had already (a document started from a contact's page,
 * a saved draft), is never replaced; a contact the process made itself follows the people (and goes when that person does).
 */
export function deriveContact(args: { people: readonly EnvelopePerson[]; current: string | null; lastDerived: string | null; manual: boolean }): string | null {
  if (args.manual) return args.current;
  if (args.current !== null && args.current !== args.lastDerived) return args.current;
  return firstContactId(args.people);
}

// ---- the summary --------------------------------------------------------------------------------------------------

export interface SummaryPerson {
  key: string;
  name: string;
  type: "signer" | "copy";
  color: number;
  /** The signature blocks assigned to them, over all the documents. */
  blocks: number;
}

export interface SummaryDocument {
  id: string;
  title: string;
  pageCount: number | null;
  state: CoverState;
  blocks: number;
}

export interface ProcessSummary {
  title: string;
  documents: SummaryDocument[];
  people: SummaryPerson[];
  left: LeftItem[];
  /** Counts of the people by type (a copy is not counted among those who must sign). */
  counts: { signers: number; copies: number };
}

export function summarize(facts: ProcessFacts, title: string): ProcessSummary {
  const f = { ...facts, people: typedPeople(facts.people) };
  const covers = f.docs.map((d) => documentCover(d, f.people));
  const people: SummaryPerson[] = [...f.people.filter(isSigner), ...f.people.filter(isCopy)]
    .map((p) => ({
      key: p.key,
      name: p.fullName.trim(),
      type: isCopy(p) ? "copy" : "signer",
      color: personColor(f.people, p.key),
      blocks: isCopy(p) ? 0 : covers.reduce((n, c) => n + (c.people.find((x) => x.key === p.key)?.blocks ?? 0), 0),
    }));
  return {
    title,
    documents: covers.map((c) => ({ id: c.doc.id, title: c.doc.title, pageCount: c.doc.pageCount, state: c.state, blocks: c.blocks })),
    people,
    left: whatIsLeft(f),
    counts: { signers: people.filter((p) => p.type === "signer").length, copies: Math.min(MAX_COPY_RECIPIENTS, people.filter((p) => p.type === "copy").length) },
  };
}
