// ============================================================
// Doc Sign, browser side: an envelope's draft as the sender edits it (migration 171). Pure functions over plain data, so what is saved,
// what is shown as wrong, and where each problem is put right are tested without a screen.
//
// The options are the ordinary draft options (one set for all the documents); the people are the ordinary people with a role on each
// document they are on. A person is saved only when complete (the server refuses a list with a person it could never send to), so a
// half-typed person lives in the browser until finished.
// ============================================================

import { MAX_SIGNERS, normalizePhone } from "../rules";
import { SIGN_LOCALES, type SignEnvelopeRow } from "../types";
import { emptyPerson, peopleFromRows, peopleIssues, type EnvelopeDocLite, type EnvelopePerson } from "../envelopes";
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
  roles: Record<string, string>;
}

/** The people as they are on screen when the envelope is loaded: the saved ones, in step order. */
export const peopleFromSigners = peopleFromRows;

/** Is this person finished enough to be saved: a name, an address, a phone for WhatsApp, a step, and a role on at least one document. */
export function personIsComplete(p: EnvelopePerson, docs: readonly EnvelopeDocLite[]): boolean {
  const name = p.fullName.trim();
  const email = p.email.trim();
  if (!name || name.length > 160 || !EMAIL_RE.test(email) || email.length > 254) return false;
  if (p.channel === "whatsapp" && normalizePhone(p.phone) === null) return false;
  if (!Number.isInteger(p.step) || p.step < 1) return false;
  return docs.some((d) => !!p.roles[d.id] && d.roles.some((r) => r.key === p.roles[d.id]));
}

/** True once the person has typed anything (an untouched blank person is not an error yet). */
export const personHasInput = (p: EnvelopePerson): boolean => p.fullName.trim() !== "" || p.email.trim() !== "" || p.phone.trim() !== "";

/** The complete people, as the server takes them. A role on a document that has no such role is left out. */
export function peoplePayload(people: readonly EnvelopePerson[], docs: readonly EnvelopeDocLite[], ordered: boolean): PersonPayload[] {
  const complete = (ordered ? [...people].sort((a, b) => a.step - b.step) : [...people]).filter((p) => personIsComplete(p, docs));
  return complete.map((p, i) => ({
    fullName: p.fullName.trim(),
    email: p.email.trim(),
    phone: p.channel === "whatsapp" ? (normalizePhone(p.phone) ?? null) : p.phone.trim() || null,
    channel: p.channel,
    step: ordered ? p.step : i + 1,
    roles: Object.fromEntries(docs.flatMap((d) => (p.roles[d.id] && d.roles.some((r) => r.key === p.roles[d.id]) ? [[d.id, p.roles[d.id]] as const] : []))),
  }));
}

/** A string that is equal for two lists the server would store identically (to skip a save that changes nothing). */
export const peopleKey = (payload: readonly PersonPayload[]): string => JSON.stringify(payload);

export function addPerson(people: readonly EnvelopePerson[], docs: readonly EnvelopeDocLite[]): EnvelopePerson[] {
  if (people.length >= MAX_SIGNERS) return [...people];
  const step = people.reduce((m, p) => Math.max(m, p.step), 0) + 1;
  // a new person starts on every document that has a role nobody has yet there
  const p = emptyPerson(step);
  for (const d of docs) {
    const free = d.roles.find((r) => !people.some((x) => x.roles[d.id] === r.key));
    if (free) p.roles[d.id] = free.key;
  }
  return [...people, p];
}

/** The people in step order with the steps renumbered 1, 2, 3 and no gap (two people who shared a number still share a step). */
export function normalizePersonSteps(people: readonly EnvelopePerson[]): EnvelopePerson[] {
  const sorted = people.map((p, i) => ({ p, i })).sort((a, b) => a.p.step - b.p.step || a.i - b.i).map((x) => x.p);
  const steps = [...new Set(sorted.map((p) => p.step))];
  return sorted.map((p) => ({ ...p, step: steps.indexOf(p.step) + 1 }));
}

export const removePerson = (people: readonly EnvelopePerson[], key: string): EnvelopePerson[] => people.filter((p) => p.key !== key);

export function updatePerson(people: readonly EnvelopePerson[], key: string, patch: Partial<Omit<EnvelopePerson, "key" | "roles">>): EnvelopePerson[] {
  return people.map((p) => (p.key === key ? { ...p, ...patch } : p));
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

// ---- what is wrong, and where it is put right -----------------------------------------------------

/** A problem found here (the shared list) as the issue shape the server uses, so both read the same way. */
export function liveEnvelopeIssues(docs: readonly EnvelopeDocLite[], people: readonly EnvelopePerson[], ordered: boolean): SignIssue[] {
  return peopleIssues(docs, people, { ordered }).filter((i) => i.code !== "person_without_document" || people.length > 0);
}

/** The codes of the shared signing list; their words are the envelope's own. */
export const ENVELOPE_PEOPLE_CODES: ReadonlySet<string> = new Set(["duplicate_person", "person_without_document", "role_two_people", "envelope_size", "envelope_too_many_pages"]);

/** Where a problem is put right: a document's own editor, the people, or the options. */
export type EnvelopeFix = { kind: "document"; documentId: string } | { kind: "people" } | { kind: "options" };

const PEOPLE = new Set(["no_signer", "no_person", "too_many_signers", "signer_name", "signer_email", "signer_phone", "signer_role", "signer_order", "order_not_unique", "same_person_twice", "role_without_person", "part_without_person", "duplicate_person", "person_without_document", "role_two_people"]);
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
