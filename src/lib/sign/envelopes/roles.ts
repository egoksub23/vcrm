// ============================================================
// Doc Sign document collections: where the roles of a document come from (migration 175's people model).
//
//   - An UPLOADED file has no roles of its own. Each person who must sign becomes a role of it: the person's key is the role's key and their
//     name the role's label, so a signature block assigned in the editor to that role is assigned to that person, and a rename of the person
//     is a rename of the role (the key, and so every field assigned to it, stays).
//   - A document from a TEMPLATE keeps the template's roles; the sender matches each of them to a person ("Match the template's roles").
//   - When a collection is sent, a person signs only the documents on which at least one field is assigned to them: the other rows are left
//     off (`pruneRows`).
//
// Pure functions over plain data: used by the screen (so it shows what the server will make) and by the services.
// ============================================================

import type { FormDefinition } from "../forms/types";
import type { PlacedField } from "../pdf/types";
import { MAX_ROLES, SENDER_ROLE, fieldsForRole } from "../rules";
import type { SignRole } from "../types";
import { isSigner, isUploadDoc, type EnvelopeDocLite, type EnvelopePerson } from "./people";

const ROLE_COLORS = 6;

/** The label of a person's role on an uploaded document: their name (kept to the 60 characters a role label holds), with the address when two share a name. */
export function roleLabelFor(person: Pick<EnvelopePerson, "fullName" | "email">, all: readonly Pick<EnvelopePerson, "fullName" | "email">[], position: number): string {
  const name = person.fullName.trim();
  if (!name) return `Person ${position}`;
  const clash = all.filter((p) => p.fullName.trim().toLowerCase() === name.toLowerCase()).length > 1;
  const label = clash && person.email.trim() ? `${name} (${person.email.trim()})` : name;
  return label.slice(0, 60);
}

/**
 * The roles the people make for an uploaded document, in the order of the people: one for each person who must sign. The colour is the
 * person's place in the list (0 to 5), so no two share one.
 */
export function peopleRoles(people: readonly EnvelopePerson[]): SignRole[] {
  const signers = people.filter(isSigner);
  return signers.slice(0, MAX_ROLES).map((p, i) => ({ key: p.key, label: roleLabelFor(p, signers, i + 1), kind: "signer", color: i % ROLE_COLORS, source: "people" }));
}

/** The documents as the screen should read them: an uploaded document's roles are the people's (the template documents are as they are). */
export function withPeopleRoles(docs: readonly EnvelopeDocLite[], people: readonly EnvelopePerson[]): EnvelopeDocLite[] {
  const roles = peopleRoles(people);
  return docs.map((d) => (isUploadDoc(d) ? { ...d, roles } : d));
}

/** The people as the screen should read them: each person who must sign has the role they made on every uploaded document. A copy has none. */
export function withUploadRoles(docs: readonly EnvelopeDocLite[], people: readonly EnvelopePerson[]): EnvelopePerson[] {
  const ups = docs.filter(isUploadDoc);
  const made = new Set(peopleRoles(people).map((r) => r.key));
  return people.map((p) => {
    if (!isSigner(p)) return p;
    const roles = { ...p.roles };
    for (const d of ups) {
      if (made.has(p.key)) roles[d.id] = p.key;
      else delete roles[d.id];
    }
    return { ...p, roles };
  });
}

/** Both of the above: what the list of people looks like on the documents once the roles are made. */
export function withDerivedRoles(docs: readonly EnvelopeDocLite[], people: readonly EnvelopePerson[]): { docs: EnvelopeDocLite[]; people: EnvelopePerson[] } {
  return { docs: withPeopleRoles(docs, people), people: withUploadRoles(docs, people) };
}

const sameRoles = (a: readonly SignRole[], b: readonly SignRole[]) =>
  a.length === b.length && a.every((r, i) => r.key === b[i].key && r.label === b[i].label && r.kind === b[i].kind && r.color === b[i].color && r.source === b[i].source);

/**
 * What an uploaded document becomes when its people change: the people's roles, and its fields without the ones assigned to a role that is gone
 * (nobody could complete them). `removed` counts those fields, for the screen to say. Fields of the sender (static text) are kept.
 *
 * A role the people did not make (one added in the editor before collections made roles from people) is kept while a field is assigned to it,
 * so no work is lost; the editor still lets the sender move those fields to a person's role and delete it.
 */
export function syncDocumentRoles(current: { roles: readonly SignRole[]; fields: readonly PlacedField[] }, people: readonly EnvelopePerson[]): { roles: SignRole[]; fields: PlacedField[]; changed: boolean; removed: number } {
  const legacy = current.roles.filter((r) => r.source !== "people" && current.fields.some((f) => f.role === r.key));
  const roles = [...peopleRoles(people), ...legacy];
  const keys = new Set(roles.map((r) => r.key));
  const kept = current.fields.filter((f) => f.role === SENDER_ROLE || keys.has(f.role));
  const removed = current.fields.length - kept.length;
  return { roles, fields: kept, changed: removed > 0 || !sameRoles(current.roles, roles), removed };
}

// ---- matching a template's roles to the people ----------------------------------------------------------

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Preselect who has each role of a template's document: the person whose name is the role's label, or, when the document has one role and
 * the collection one person who must sign, that person. Only fills a role nobody has yet, and never puts a person in two roles of one
 * document or two people in one role. What the sender chose is never changed.
 */
export function autoMatchTemplateRoles(docs: readonly EnvelopeDocLite[], people: readonly EnvelopePerson[]): EnvelopePerson[] {
  const signers = people.filter(isSigner);
  const next = people.map((p) => ({ ...p, roles: { ...p.roles } }));
  for (const d of docs) {
    if (isUploadDoc(d)) continue;
    const taken = new Set(next.filter(isSigner).flatMap((p) => (p.roles[d.id] ? [p.roles[d.id]] : [])));
    const onDoc = (p: EnvelopePerson) => !!p.roles[d.id];
    for (const r of d.roles) {
      if (taken.has(r.key)) continue;
      const free = next.filter((p) => isSigner(p) && !onDoc(p));
      const byName = free.find((p) => p.fullName.trim() && norm(p.fullName) === norm(r.label));
      const only = d.roles.length === 1 && signers.length === 1 ? free[0] : undefined;
      const pick = byName ?? only;
      if (!pick) continue;
      pick.roles[d.id] = r.key;
      taken.add(r.key);
    }
  }
  return next;
}

// ---- who signs what, at send ------------------------------------------------------------------------------

/** What pruning needs to know of a document. */
export interface PruneDoc {
  id: string;
  fields_snapshot: readonly PlacedField[];
  form_snapshot?: FormDefinition | null;
}

/** Has this role something to complete on the document: a field assigned to it that a person answers, or a part of the form. */
export function roleHasWork(doc: PruneDoc, roleKey: string): boolean {
  return fieldsForRole(doc.fields_snapshot, roleKey).length > 0 || (doc.form_snapshot?.parts ?? []).some((p) => p.role === roleKey);
}

/**
 * Split the rows of a collection's signing list into the ones that stay and the ones that go: a person signs only the documents on which
 * at least one field is assigned to them, so their row on any other document is dropped.
 */
export function pruneRows<R extends { document_id: string; role_key: string }>(docs: readonly PruneDoc[], rows: readonly R[]): { keep: R[]; dropped: R[] } {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const keep: R[] = [];
  const dropped: R[] = [];
  for (const r of rows) {
    const doc = byId.get(r.document_id);
    if (doc && roleHasWork(doc, r.role_key)) keep.push(r);
    else dropped.push(r);
  }
  return { keep, dropped };
}
