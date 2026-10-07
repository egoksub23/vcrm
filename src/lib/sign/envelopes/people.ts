// ============================================================
// Doc Sign document collections (migration 171, with the people model of migration 175): the people of a collection.
//
// A PERSON is a name, an email and a TYPE: "Must sign" or "Receives a copy". A person who must sign gets one row on each document they are
// on, tied together by `party_id` (the row on their first document is the anchor and carries the link). Which documents they are on, and in
// which role, comes from the documents:
//   - a document with no roles of its own (an uploaded file) takes a role from each person who must sign: the person's key is the role's key
//     and their name its label (see ./roles.ts), so a signature block assigned to that role is assigned to that person;
//   - a document from a template keeps the template's roles, and the sender matches each of them to a person (`roles`).
// A person who receives a copy has no role, no link, no step and no row: the signed copy is mailed to them when everything is signed.
//
// Pure functions over plain data, so the mapping of roles to people, the conflicts and the rows that would be saved are tested without a
// screen or a database.
// ============================================================

import { MAX_ROLES, MAX_SIGNERS, SENDER_ROLE, normalizePhone, type Issue } from "../rules";
import type { SignChannel, SignMode, SignRole, SignSignerRow, SignerKind } from "../types";

/** The most people who can receive a copy of one document or collection (the database holds the same line). */
export const MAX_COPY_RECIPIENTS = 10;

/** What a person is on the collection. */
export type PersonType = "signer" | "copy";

/** What the people step needs to know of a document of the envelope. */
export interface EnvelopeDocLite {
  id: string;
  position: number;
  title: string;
  roles: readonly SignRole[];
  mode?: SignMode;
  /** The roles that have something to complete on the document (a role with nothing to do needs nobody). Absent: every role is taken to need a person. */
  needed?: readonly string[];
  /**
   * Made from a template: its roles are the template's, and the sender matches them to people. `false` for an uploaded file, whose roles come from
   * the people. Absent: taken to be from a template (so the roles it carries are kept as they are).
   */
  fromTemplate?: boolean;
}

export interface EnvelopePerson {
  /** A key for the screen (and, for a person who must sign, the key of their role on the documents that have none of their own). */
  key: string;
  fullName: string;
  email: string;
  /** Kept as typed; only used (and checked) for WhatsApp. */
  phone: string;
  channel: SignChannel;
  /** The signing step (people who share a number sign together). Only meaningful when the envelope needs signing order. */
  step: number;
  /**
   * The role this person has on each document, by document id. A document that is absent (or "") is one the person is not on. For a document
   * with no roles of its own it is the person's own role (set from `key`); for a template's document it is the role the sender matched.
   */
  roles: Record<string, string>;
  /** Must sign (the default) or receives a copy. A person who receives a copy has no roles, channel, phone or step of their own. */
  type?: PersonType;
  /** The contact this person was taken from (the screen only; never saved). */
  contactId?: string | null;
  /** Saved people only: the party id their rows share (the id of their anchor row). */
  partyId?: string;
  /** A document on its own only: the person is a Halo user of this workspace (a countersigner); their name and email are theirs. */
  internalUserId?: string | null;
}

/** What one saved row of the signing list is (a person's role on one document). */
export interface EnvelopeSignerRow {
  id: string;
  partyId: string;
  documentId: string;
  roleKey: string;
  kind: SignerKind;
  fullName: string;
  email: string;
  phone: string | null;
  channel: SignChannel;
  orderNo: number;
  internalUserId?: string | null;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** The keys the people of a collection make for themselves: `pp_` and 8 lower-case letters or digits. */
export const PERSON_KEY_RE = /^pp_[a-z0-9]{4,36}$/;

/** A new person's key: random, so two people (and two sessions) never share one. */
export const newPersonKey = (): string => {
  let s = "";
  while (s.length < 8) s += Math.floor(Math.random() * 36).toString(36);
  return `pp_${s}`;
};

export const isSigner = (p: { type?: PersonType }): boolean => (p.type ?? "signer") === "signer";
export const isCopy = (p: { type?: PersonType }): boolean => p.type === "copy";

export function emptyPerson(step = 1, type: PersonType = "signer"): EnvelopePerson {
  return { key: newPersonKey(), fullName: "", email: "", phone: "", channel: "email", step, roles: {}, ...(type === "copy" ? { type } : {}) };
}

const inOrder = <T extends { position: number }>(docs: readonly T[]): T[] => [...docs].sort((a, b) => a.position - b.position);

/** A document that gets its roles from the people: an uploaded file (it was not made from a template). */
export const isUploadDoc = (d: Pick<EnvelopeDocLite, "fromTemplate">): boolean => d.fromTemplate === false;

/**
 * A starting list: one person for each role KEY found on the documents that came from a template, on every document that has that role.
 * Documents made for the same people usually name the same roles ("merchant", "director"), so they line up by themselves; roles with
 * different keys start as different people, and the sender matches them by hand. An uploaded file has no roles to start from (its roles come
 * from the people), so it adds nobody.
 */
export function seedPeople(docs: readonly EnvelopeDocLite[]): EnvelopePerson[] {
  const byKey = new Map<string, EnvelopePerson>();
  for (const d of inOrder(docs)) {
    if (isUploadDoc(d)) continue;
    for (const r of d.roles) {
      let p = byKey.get(r.key);
      if (!p) {
        p = emptyPerson(byKey.size + 1);
        byKey.set(r.key, p);
      }
      p.roles[d.id] = r.key;
    }
  }
  return [...byKey.values()].slice(0, MAX_SIGNERS);
}

/**
 * The saved rows as people: the rows with one party id are one person. In step order, then in the order they were made. A person's key is the
 * key of their role on a document that took its role from them (so it stays the same across saves); a person with no such role is keyed by
 * their party id.
 */
export function peopleFromRows(rows: readonly SignSignerRow[]): EnvelopePerson[] {
  const groups = new Map<string, SignSignerRow[]>();
  for (const r of rows) {
    if (r.part_keys && r.part_keys.length > 0) continue; // never in an envelope; ignored if it ever happens
    const key = r.party_id ?? r.id;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const people: EnvelopePerson[] = [];
  for (const [key, list] of groups) {
    const first = list.find((r) => r.id === key) ?? list[0];
    const own = list.find((r) => PERSON_KEY_RE.test(r.role_key));
    people.push({
      key: own ? own.role_key : key,
      partyId: key,
      fullName: first.full_name,
      email: first.email,
      phone: first.phone ?? "",
      channel: first.channel,
      step: first.order_no,
      roles: Object.fromEntries(list.map((r) => [r.document_id, r.role_key])),
      ...(first.internal_user_id ? { internalUserId: first.internal_user_id } : {}),
    });
  }
  return people.sort((a, b) => a.step - b.step || a.fullName.localeCompare(b.fullName));
}

/** The documents a person is on, in the envelope's order. */
export function documentsOf(docs: readonly EnvelopeDocLite[], person: EnvelopePerson): EnvelopeDocLite[] {
  return inOrder(docs).filter((d) => !!person.roles[d.id]);
}

/** Who has each role of each document: the places the sender must look at (a role that needs someone and has nobody, a role with two). */
export function roleCoverage(docs: readonly EnvelopeDocLite[], people: readonly EnvelopePerson[]): { documentId: string; roleKey: string; people: number; needed: boolean }[] {
  const out: { documentId: string; roleKey: string; people: number; needed: boolean }[] = [];
  const signers = people.filter(isSigner);
  for (const d of inOrder(docs)) {
    for (const r of d.roles) out.push({ documentId: d.id, roleKey: r.key, people: signers.filter((p) => p.roles[d.id] === r.key).length, needed: !d.needed || d.needed.includes(r.key) });
  }
  return out;
}

/**
 * What stops this list from being saved or sent, as the envelope sees it (each document's own readiness is `sendProblems`, checked per
 * document by the server). `detail` is the index of the person (in `people`, copies included).
 */
export function peopleIssues(docs: readonly EnvelopeDocLite[], people: readonly EnvelopePerson[], opts: { ordered: boolean }): Issue[] {
  const issues: Issue[] = [];
  const signerCount = people.filter(isSigner).length;
  const copyCount = people.length - signerCount;
  if (signerCount > MAX_SIGNERS) issues.push({ code: "too_many_signers", detail: String(MAX_SIGNERS) });
  if (copyCount > MAX_COPY_RECIPIENTS) issues.push({ code: "too_many_copies", detail: String(MAX_COPY_RECIPIENTS) });
  // an uploaded file takes one role from each person who must sign, and a document holds a few roles
  if (docs.some(isUploadDoc) && signerCount > MAX_ROLES) issues.push({ code: "too_many_roles", detail: String(MAX_ROLES) });
  const byId = new Map(docs.map((d) => [d.id, d]));
  const seen = new Map<string, number>();
  const seenUsers = new Set<string>();
  people.forEach((p, i) => {
    const at = { detail: String(i) };
    if (!p.fullName.trim() || p.fullName.trim().length > 160) issues.push({ code: "signer_name", ...at });
    const email = p.email.trim();
    if (!EMAIL_RE.test(email) || email.length > 254) issues.push({ code: "signer_email", ...at });
    const lower = email.toLowerCase();
    if (lower) {
      // one human, one entry: two entries would be two links (and two invitations) for one person, or a copy that goes to someone who already signs
      if (seen.has(lower)) issues.push({ code: "duplicate_person", ...at });
      seen.set(lower, i);
    }
    // one Halo user is one person too: two entries for the same user would be two places that one login can open
    if (p.internalUserId) {
      if (seenUsers.has(p.internalUserId)) issues.push({ code: "duplicate_person", ...at });
      seenUsers.add(p.internalUserId);
    }
    if (!isSigner(p)) return;
    if (p.channel === "whatsapp" && !normalizePhone(p.phone)) issues.push({ code: "signer_phone", ...at });
    if (!Number.isInteger(p.step) || p.step < 1) issues.push({ code: "signer_order", ...at });
    let on = 0;
    for (const [documentId, roleKey] of Object.entries(p.roles)) {
      if (!roleKey) continue;
      const doc = byId.get(documentId);
      if (!doc || roleKey === SENDER_ROLE || !doc.roles.some((r) => r.key === roleKey)) {
        issues.push({ code: "signer_role", ...at, ...(doc ? { document: doc.id } : {}), role: roleKey });
        continue;
      }
      on++;
    }
    if (on === 0) issues.push({ code: "person_without_document", ...at });
  });
  // a role is held by one person on a document (the same role for two people would have them answer the same places)
  for (const c of roleCoverage(docs, people)) {
    if (c.people > 1) issues.push({ code: "role_two_people", document: c.documentId, role: c.roleKey });
  }
  void opts;
  return issues;
}

/**
 * The rows to save. The person's row on their first document is the anchor: its id IS the party id, and every other row of the person
 * carries it. Without signing order everyone is in step 1... but each row keeps the person's position so the list reads in order.
 * `newId` makes an id (a random UUID). A person who receives a copy has no row.
 */
export function rowsFor(docs: readonly EnvelopeDocLite[], people: readonly EnvelopePerson[], opts: { ordered: boolean; newId: () => string }): EnvelopeSignerRow[] {
  const rows: EnvelopeSignerRow[] = [];
  let place = 0;
  people.forEach((p) => {
    if (!isSigner(p)) return;
    place += 1;
    const mine = documentsOf(docs, p);
    if (mine.length === 0) return;
    const partyId = opts.newId();
    mine.forEach((d, n) => {
      const roleKey = p.roles[d.id];
      const role = d.roles.find((r) => r.key === roleKey);
      rows.push({
        id: n === 0 ? partyId : opts.newId(),
        partyId,
        documentId: d.id,
        roleKey,
        // in a form without a signature nobody signs: everyone is a person who fills it in
        kind: d.mode === "form" ? "filler" : (role?.kind ?? "signer"),
        fullName: p.fullName.trim(),
        email: p.email.trim(),
        phone: p.channel === "whatsapp" ? normalizePhone(p.phone) : p.phone.trim() || null,
        channel: p.channel,
        orderNo: opts.ordered ? Math.max(1, Math.floor(p.step || 1)) : place,
        ...(p.internalUserId ? { internalUserId: p.internalUserId } : {}),
      });
    });
  });
  return rows;
}
