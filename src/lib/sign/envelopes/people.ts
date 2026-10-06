// ============================================================
// Doc Sign envelopes (migration 171): the shared signing list. One PERSON is one entry with a role on each document they are on; the
// database holds one row per document for them, tied together by `party_id` (the row on their first document is the anchor and
// carries the link). Pure functions over plain data, so the mapping of roles to people, the conflicts and the rows that would be
// saved are tested without a screen or a database.
// ============================================================

import { MAX_SIGNERS, SENDER_ROLE, normalizePhone, type Issue } from "../rules";
import type { SignChannel, SignMode, SignRole, SignSignerRow, SignerKind } from "../types";

/** What the people step needs to know of a document of the envelope. */
export interface EnvelopeDocLite {
  id: string;
  position: number;
  title: string;
  roles: readonly SignRole[];
  mode?: SignMode;
  /** The roles that have something to complete on the document (a role with nothing to do needs nobody). Absent: every role is taken to need a person. */
  needed?: readonly string[];
}

export interface EnvelopePerson {
  /** A key for the screen (the party id once the person is saved). */
  key: string;
  fullName: string;
  email: string;
  /** Kept as typed; only used (and checked) for WhatsApp. */
  phone: string;
  channel: SignChannel;
  /** The signing step (people who share a number sign together). Only meaningful when the envelope needs signing order. */
  step: number;
  /** The role this person has on each document, by document id. A document that is absent (or "") is one the person is not on. */
  roles: Record<string, string>;
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
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

let counter = 0;
export const newPersonKey = (): string => `person${++counter}`;

export function emptyPerson(step = 1): EnvelopePerson {
  return { key: newPersonKey(), fullName: "", email: "", phone: "", channel: "email", step, roles: {} };
}

const inOrder = <T extends { position: number }>(docs: readonly T[]): T[] => [...docs].sort((a, b) => a.position - b.position);

/**
 * A starting list: one person for each role KEY found on the documents, on every document that has that role. Documents made for the
 * same people usually name the same roles ("merchant", "director"), so they line up by themselves; roles with different keys start
 * as different people, and the sender maps them by hand.
 */
export function seedPeople(docs: readonly EnvelopeDocLite[]): EnvelopePerson[] {
  const byKey = new Map<string, EnvelopePerson>();
  for (const d of inOrder(docs)) {
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

/** The saved rows as people: the rows with one party id are one person. In step order, then in the order they were made. */
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
    people.push({
      key,
      fullName: first.full_name,
      email: first.email,
      phone: first.phone ?? "",
      channel: first.channel,
      step: first.order_no,
      roles: Object.fromEntries(list.map((r) => [r.document_id, r.role_key])),
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
  for (const d of inOrder(docs)) {
    for (const r of d.roles) out.push({ documentId: d.id, roleKey: r.key, people: people.filter((p) => p.roles[d.id] === r.key).length, needed: !d.needed || d.needed.includes(r.key) });
  }
  return out;
}

/**
 * What stops this list from being saved or sent, as the envelope sees it (each document's own readiness is `sendProblems`, checked per
 * document by the server). `detail` is the index of the person.
 */
export function peopleIssues(docs: readonly EnvelopeDocLite[], people: readonly EnvelopePerson[], opts: { ordered: boolean }): Issue[] {
  const issues: Issue[] = [];
  if (people.length > MAX_SIGNERS) issues.push({ code: "too_many_signers", detail: String(MAX_SIGNERS) });
  const byId = new Map(docs.map((d) => [d.id, d]));
  const seen = new Map<string, number>();
  people.forEach((p, i) => {
    const at = { detail: String(i) };
    if (!p.fullName.trim() || p.fullName.trim().length > 160) issues.push({ code: "signer_name", ...at });
    const email = p.email.trim();
    if (!EMAIL_RE.test(email) || email.length > 254) issues.push({ code: "signer_email", ...at });
    if (p.channel === "whatsapp" && !normalizePhone(p.phone)) issues.push({ code: "signer_phone", ...at });
    if (!Number.isInteger(p.step) || p.step < 1) issues.push({ code: "signer_order", ...at });
    const lower = email.toLowerCase();
    if (lower) {
      // one human, one entry: two entries would be two links (and two invitations) for one person
      if (seen.has(lower)) issues.push({ code: "duplicate_person", ...at });
      seen.set(lower, i);
    }
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
 * `newId` makes an id (a random UUID).
 */
export function rowsFor(docs: readonly EnvelopeDocLite[], people: readonly EnvelopePerson[], opts: { ordered: boolean; newId: () => string }): EnvelopeSignerRow[] {
  const rows: EnvelopeSignerRow[] = [];
  people.forEach((p, i) => {
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
        orderNo: opts.ordered ? Math.max(1, Math.floor(p.step || 1)) : i + 1,
      });
    });
  });
  return rows;
}
