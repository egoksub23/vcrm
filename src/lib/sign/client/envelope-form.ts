// ============================================================
// Doc Sign, browser side: a collection's draft as the sender edits it (migration 171, with the people model of migration 175). Pure functions
// over plain data, so what is saved, what is shown as wrong, and where each problem is put right are tested without a screen.
//
// The options are the ordinary draft options (one set for all the documents). The people are a name, an email and a TYPE ("Must sign" or
// "Receives a copy"): the roles they have on the documents are not typed here. A document with no roles of its own (an uploaded file) takes a
// role from each person who must sign; for a document from a template the sender matches each template role to a person. A person is saved
// only when complete (the server refuses a list with a person it could never send to), so a half-typed person lives in the browser until
// finished.
// ============================================================

import { MAX_SIGNERS, normalizePhone } from "../rules";
import { SIGN_LOCALES, type SignCopyRecipientRow, type SignEnvelopeRow } from "../types";
import {
  MAX_COPY_RECIPIENTS,
  autoMatchTemplateRoles,
  emptyPerson,
  isCopy,
  isSigner,
  isUploadDoc,
  peopleFromRows,
  peopleIssues,
  withDerivedRoles,
  type EnvelopeDocLite,
  type EnvelopePerson,
  type PersonType,
} from "../envelopes";
import { reminderText, toDateInput, optionsPatch, type DraftOptions, type OptionsPatch } from "./draft-options";
import type { SignIssue } from "./api";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ---- the options ------------------------------------------------------------------------------

/** The envelope's options in the shape the options screen edits (the category and forwarding do not apply to an envelope). */
export function optionsFromEnvelope(env: SignEnvelopeRow, links: { ticketId?: string | null; dealId?: string | null } = {}): DraftOptions {
  return {
    title: env.title,
    categoryId: null,
    contactId: env.contact_id,
    ticketId: links.ticketId ?? null,
    dealId: links.dealId ?? null,
    locale: SIGN_LOCALES.includes(env.locale) ? env.locale : "en",
    message: env.message ?? "",
    expiryDate: toDateInput(env.expires_at),
    reminderText: reminderText(env.reminder_days),
    codeRequired: env.code_required,
    signInOrder: env.sign_in_order,
    allowForwarding: false,
  };
}

/** What `PATCH /api/sign/envelopes/:id` takes: what differs, without anything that is not an envelope's. */
export function envelopePatch(saved: DraftOptions, next: DraftOptions, now: Date): OptionsPatch {
  const patch = optionsPatch({ ...saved, categoryId: null, allowForwarding: false }, { ...next, categoryId: null, allowForwarding: false }, now);
  delete patch.categoryId;
  delete patch.allowForwarding;
  return patch;
}

// ---- the people -------------------------------------------------------------------------------

/** What the server's signing-list route takes for one person. */
export interface PersonPayload {
  fullName: string;
  email: string;
  phone: string | null;
  channel: "email" | "whatsapp";
  step: number;
  /** For the documents that came from a template: the template's role this person has on each. An uploaded file's roles are made from the people. */
  roles: Record<string, string>;
  type: PersonType;
  /** A person who must sign keeps one key for good: it is their role on the uploaded documents, so a rename never moves their fields. */
  key: string;
  /** Still being filled in (no valid address yet, say): not saved as a signer, but their role and the fields assigned to it are kept. */
  incomplete?: boolean;
}

/**
 * The people as they are on screen when the collection is loaded: the people who must sign (the saved ones, in step order), then the people who
 * receive a copy.
 */
export function peopleFromSigners(rows: Parameters<typeof peopleFromRows>[0], copies: readonly Pick<SignCopyRecipientRow, "id" | "full_name" | "email">[] = []): EnvelopePerson[] {
  return [
    ...peopleFromRows(rows),
    ...copies.map((c): EnvelopePerson => ({ key: c.id, fullName: c.full_name, email: c.email, phone: "", channel: "email", step: 1, roles: {}, type: "copy" })),
  ];
}

const nameOk = (p: EnvelopePerson) => {
  const name = p.fullName.trim();
  return !!name && name.length <= 160;
};
const emailOk = (p: EnvelopePerson) => EMAIL_RE.test(p.email.trim()) && p.email.trim().length <= 254;

/**
 * Is this person finished enough to be saved: a name and an address; for a person who must sign also a phone for WhatsApp, a step, and a place on
 * the documents: an uploaded file gives every person a role, so one is enough, and with only template documents a template role must have been
 * matched to them. A person who receives a copy needs only the name and the address.
 */
export function personIsComplete(p: EnvelopePerson, docs: readonly EnvelopeDocLite[]): boolean {
  if (!nameOk(p) || !emailOk(p)) return false;
  if (isCopy(p)) return true;
  if (p.channel === "whatsapp" && normalizePhone(p.phone) === null) return false;
  if (!Number.isInteger(p.step) || p.step < 1) return false;
  const derived = withDerivedRoles(docs, [p]);
  const mine = derived.people[0];
  return derived.docs.some((d) => !!mine.roles[d.id] && d.roles.some((r) => r.key === mine.roles[d.id]));
}

/** True once the person has typed anything (an untouched blank person is not an error yet). */
export const personHasInput = (p: EnvelopePerson): boolean => p.fullName.trim() !== "" || p.email.trim() !== "" || p.phone.trim() !== "";

/**
 * The complete people, as the server takes them: the people who must sign (in step order when there is signing order), then the people who receive
 * a copy (at most 10). A template role that the document does not have is left out; an uploaded file's roles are not sent (the server makes them).
 */
export function peoplePayload(people: readonly EnvelopePerson[], docs: readonly EnvelopeDocLite[], ordered: boolean): PersonPayload[] {
  const everySigner = ordered ? [...people.filter(isSigner)].sort((a, b) => a.step - b.step) : people.filter(isSigner);
  const signers = everySigner.filter((p) => personIsComplete(p, docs));
  // a person still being filled in is sent too, flagged: the server keeps their role (and the fields assigned to it) on the uploaded documents and saves nothing else of them
  const unfinished = everySigner.filter((p) => !personIsComplete(p, docs));
  const copies = people
    .filter(isCopy)
    .filter((p) => personIsComplete(p, docs))
    .slice(0, MAX_COPY_RECIPIENTS);
  const template = docs.filter((d) => !isUploadDoc(d));
  const asUnfinished = (p: EnvelopePerson): PersonPayload => ({
    fullName: p.fullName.trim(),
    email: p.email.trim(),
    phone: p.phone.trim() || null,
    channel: p.channel,
    step: Number.isInteger(p.step) && p.step >= 1 ? p.step : 1,
    roles: Object.fromEntries(template.flatMap((d) => (p.roles[d.id] && d.roles.some((r) => r.key === p.roles[d.id]) ? [[d.id, p.roles[d.id]] as const] : []))),
    type: "signer",
    key: p.key,
    incomplete: true,
  });
  return [
    ...signers.map(
      (p, i): PersonPayload => ({
        fullName: p.fullName.trim(),
        email: p.email.trim(),
        phone: p.channel === "whatsapp" ? (normalizePhone(p.phone) ?? null) : p.phone.trim() || null,
        channel: p.channel,
        step: ordered ? p.step : i + 1,
        roles: Object.fromEntries(template.flatMap((d) => (p.roles[d.id] && d.roles.some((r) => r.key === p.roles[d.id]) ? [[d.id, p.roles[d.id]] as const] : []))),
        type: "signer",
        key: p.key,
      }),
    ),
    ...unfinished.map(asUnfinished),
    ...copies.map((p): PersonPayload => ({ fullName: p.fullName.trim(), email: p.email.trim(), phone: null, channel: "email", step: 1, roles: {}, type: "copy", key: p.key })),
  ];
}

/** A string that is equal for two lists the server would store identically (to skip a save that changes nothing). */
export const peopleKey = (payload: readonly PersonPayload[]): string => JSON.stringify(payload);

/** How many people of each type are on the list (for the "add" buttons' limits and the review). */
export function countByType(people: readonly EnvelopePerson[]): { signers: number; copies: number } {
  const copies = people.filter(isCopy).length;
  return { signers: people.length - copies, copies };
}

/**
 * Preselect who has each role of a template's document (a person whose name is the role's label; or the one person and the one role there are).
 * Only fills a role nobody has; what the sender chose is never changed. A collection of uploaded files has nothing to match.
 */
export const matchTemplateRoles = (people: readonly EnvelopePerson[], docs: readonly EnvelopeDocLite[]): EnvelopePerson[] => autoMatchTemplateRoles(docs, people);

/** The people who must sign first, in the order they were added, then the people who receive a copy. */
const grouped = (people: readonly EnvelopePerson[]): EnvelopePerson[] => [...people.filter(isSigner), ...people.filter(isCopy)];

/**
 * Add a person of a type, at the end: a new person who must sign starts a step of their own; a person who receives a copy has none. The template
 * roles are matched for them where they fit. Nothing is added past a limit (20 who must sign, 10 who receive a copy).
 */
export function addPerson(
  people: readonly EnvelopePerson[],
  docs: readonly EnvelopeDocLite[],
  type: PersonType = "signer",
  init: Partial<Pick<EnvelopePerson, "fullName" | "email" | "phone" | "contactId">> = {},
): EnvelopePerson[] {
  const { signers, copies } = countByType(people);
  if (type === "signer" ? signers >= MAX_SIGNERS : copies >= MAX_COPY_RECIPIENTS) return [...people];
  const step = people.filter(isSigner).reduce((m, p) => Math.max(m, p.step), 0) + 1;
  const added: EnvelopePerson = { ...emptyPerson(step, type), ...init };
  return matchTemplateRoles(grouped([...people, added]), docs);
}

/** The people in step order with the steps renumbered 1, 2, 3 and no gap (two people who shared a number still share a step). People who receive a copy have no step and stay last. */
export function normalizePersonSteps(people: readonly EnvelopePerson[]): EnvelopePerson[] {
  const signers = people.filter(isSigner);
  const sorted = signers.map((p, i) => ({ p, i })).sort((a, b) => a.p.step - b.p.step || a.i - b.i).map((x) => x.p);
  const steps = [...new Set(sorted.map((p) => p.step))];
  return [...sorted.map((p) => ({ ...p, step: steps.indexOf(p.step) + 1 })), ...people.filter(isCopy)];
}

export const removePerson = (people: readonly EnvelopePerson[], key: string): EnvelopePerson[] => people.filter((p) => p.key !== key);

/**
 * Change what a person is (name, email, channel, phone, step, contact). A new name may now be the label of a template's role, so the template
 * roles are matched again (only roles nobody has).
 */
export function updatePerson(people: readonly EnvelopePerson[], key: string, patch: Partial<Omit<EnvelopePerson, "key" | "roles">>, docs?: readonly EnvelopeDocLite[]): EnvelopePerson[] {
  const next = people.map((p) => (p.key === key ? { ...p, ...patch } : p));
  return docs && patch.fullName !== undefined ? matchTemplateRoles(next, docs) : next;
}

/** Give a person a role on a document (`roleKey` "" takes them off it). */
export function setPersonRole(people: readonly EnvelopePerson[], key: string, documentId: string, roleKey: string): EnvelopePerson[] {
  return people.map((p) => {
    if (p.key !== key) return p;
    const roles = { ...p.roles };
    if (roleKey) roles[documentId] = roleKey;
    else delete roles[documentId];
    return { ...p, roles };
  });
}

/**
 * Change a person's type. A person who receives a copy has no roles, channel, phone or step; one who must sign again starts on email in a step of
 * their own, with the template roles matched where they fit. Nothing changes when the limit of the other type is reached.
 */
export function setPersonType(people: readonly EnvelopePerson[], key: string, type: PersonType, docs: readonly EnvelopeDocLite[]): EnvelopePerson[] {
  const me = people.find((p) => p.key === key);
  if (!me || (me.type ?? "signer") === type) return [...people];
  if (type === "copy") {
    if (people.filter(isCopy).length >= MAX_COPY_RECIPIENTS) return [...people];
    return grouped(people.map((p) => (p.key === key ? { ...p, type: "copy" as const, roles: {}, channel: "email" as const, phone: "", step: 1 } : p)));
  }
  if (people.filter(isSigner).length >= MAX_SIGNERS) return [...people];
  const step = people.filter(isSigner).reduce((m, p) => Math.max(m, p.step), 0) + 1;
  const back: EnvelopePerson = { key: me.key, fullName: me.fullName, email: me.email, phone: "", channel: "email", step, roles: {}, ...(me.contactId ? { contactId: me.contactId } : {}) };
  return matchTemplateRoles(grouped(people.map((p) => (p.key === key ? back : p))), docs);
}

/** What choosing a contact does to a person: their name and email fill the row (the email stays editable), and a phone number is kept for WhatsApp when there is one. */
export function personFromContact(contact: { id?: string | null; name?: string | null; email?: string | null; phone?: string | null }): Partial<Pick<EnvelopePerson, "fullName" | "email" | "phone" | "contactId">> {
  return { fullName: contact.name?.trim() ?? "", email: contact.email?.trim() ?? "", phone: contact.phone?.trim() ?? "", contactId: contact.id ?? null };
}

/** One role of a document that came from a template, and the person who has it (by key), for "Match the template's roles". */
export interface TemplateMatch {
  documentId: string;
  documentTitle: string;
  roleKey: string;
  roleLabel: string;
  personKey: string | null;
}

/** A line for each role of each document that came from a template (uploaded files have none: their roles are the people), in the order of the documents. */
export function templateMatches(docs: readonly EnvelopeDocLite[], people: readonly EnvelopePerson[]): TemplateMatch[] {
  const signers = people.filter(isSigner);
  return [...docs]
    .filter((d) => !isUploadDoc(d))
    .sort((a, b) => a.position - b.position)
    .flatMap((d) => d.roles.map((r) => ({ documentId: d.id, documentTitle: d.title, roleKey: r.key, roleLabel: r.label, personKey: signers.find((p) => p.roles[d.id] === r.key)?.key ?? null })));
}

/** Give a template's role to a person (`personKey` null leaves it with nobody). A person keeps one role on a document, and a role has one person. */
export function setTemplateMatch(people: readonly EnvelopePerson[], documentId: string, roleKey: string, personKey: string | null): EnvelopePerson[] {
  return people.map((p) => {
    if (!isSigner(p)) return p;
    const roles = { ...p.roles };
    if (p.key === personKey) roles[documentId] = roleKey;
    else if (roles[documentId] === roleKey) delete roles[documentId];
    return { ...p, roles };
  });
}

/** What the documents have assigned to a person who must sign: how many fields on how many documents (so removing them can say what goes with them). */
export function assignedWork(
  people: readonly EnvelopePerson[],
  key: string,
  docs: readonly { id: string; fromTemplate?: boolean; fieldCounts?: Record<string, number> }[],
): { fields: number; documents: number } {
  const me = people.find((p) => p.key === key);
  let fields = 0;
  let documents = 0;
  for (const d of docs) {
    // on an uploaded file the person's role is their key; on a template's document it is the role the sender matched
    const roleKey = d.fromTemplate === false ? key : me?.roles[d.id];
    const n = roleKey ? (d.fieldCounts?.[roleKey] ?? 0) : 0;
    if (n > 0) {
      fields += n;
      documents += 1;
    }
  }
  return { fields, documents };
}

// ---- what is wrong, and where it is put right -----------------------------------------------------

/** A problem found here (the shared list) as the issue shape the server uses, so both read the same way. */
export function liveEnvelopeIssues(docs: readonly EnvelopeDocLite[], people: readonly EnvelopePerson[], ordered: boolean): SignIssue[] {
  // what the people look like once the uploaded documents have taken their roles
  const derived = withDerivedRoles(docs, people);
  return peopleIssues(derived.docs, derived.people, { ordered }).filter((i) => i.code !== "person_without_document" || people.length > 0);
}

/** The codes of the shared list; their words are the collection's own. */
export const ENVELOPE_PEOPLE_CODES: ReadonlySet<string> = new Set([
  "duplicate_person",
  "person_without_document",
  "person_without_work",
  "role_two_people",
  "envelope_size",
  "envelope_too_many_pages",
  "too_many_copies",
  "too_many_roles",
]);

/** Where a problem is put right: a document's own editor, the people, or the options. */
export type EnvelopeFix = { kind: "document"; documentId: string } | { kind: "people" } | { kind: "options" };

const PEOPLE = new Set([
  "no_signer",
  "no_person",
  "too_many_signers",
  "signer_name",
  "signer_email",
  "signer_phone",
  "signer_role",
  "signer_order",
  "order_not_unique",
  "same_person_twice",
  "role_without_person",
  "part_without_person",
  "duplicate_person",
  "person_without_document",
  "person_without_work",
  "role_two_people",
  "too_many_copies",
  "too_many_roles",
]);
const OPTIONS = new Set(["title_required", "message_long", "expiry_past", "reminders_bad"]);

export function fixFor(issue: SignIssue): EnvelopeFix {
  if (OPTIONS.has(issue.code)) return { kind: "options" };
  if (PEOPLE.has(issue.code) || ENVELOPE_PEOPLE_CODES.has(issue.code)) return { kind: "people" };
  return issue.document ? { kind: "document", documentId: issue.document } : { kind: "people" };
}

/** The issues of the server and of this screen, each once. */
export function dedupeEnvelopeIssues(issues: readonly SignIssue[]): SignIssue[] {
  const seen = new Set<string>();
  const out: SignIssue[] = [];
  for (const i of issues) {
    const k = `${i.code}|${i.document ?? ""}|${i.field ?? ""}|${i.role ?? ""}|${i.detail ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(i);
  }
  return out;
}

/** A document's layout problems are many and small: they are counted for the document, not listed one by one. */
export function groupByDocument(issues: readonly SignIssue[]): { documentId: string | null; issues: SignIssue[] }[] {
  const order: (string | null)[] = [];
  const by = new Map<string | null, SignIssue[]>();
  for (const i of issues) {
    const k = i.document ?? null;
    if (!by.has(k)) {
      by.set(k, []);
      order.push(k);
    }
    by.get(k)!.push(i);
  }
  return order.map((k) => ({ documentId: k, issues: by.get(k)! }));
}
