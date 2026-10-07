// ============================================================
// Doc Sign document collections: the small decisions the People step makes when someone acts on a row, kept apart from the screen so they are
// tested without one (choosing a contact for a person, and what removing a person who has work assigned must ask first).
// ============================================================

import { assignedWork, updatePerson } from "@/lib/sign/client/envelope-form";
import { isSigner, type EnvelopeDocLite, type EnvelopePerson } from "@/lib/sign/envelopes";

/** What of a contact the People step uses. */
export interface ContactChoice {
  id?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}

/**
 * A contact was chosen for a person: their name and email fill the row (the email stays editable). A contact with no email leaves the typed email
 * alone, and one with no name leaves the typed name. A phone number is kept for WhatsApp for a person who must sign. The contact id is for the
 * screen only (it is never saved).
 */
export function applyContact(people: readonly EnvelopePerson[], key: string, contact: ContactChoice, docs: readonly EnvelopeDocLite[]): EnvelopePerson[] {
  const me = people.find((p) => p.key === key);
  if (!me) return [...people];
  const patch: Partial<Pick<EnvelopePerson, "fullName" | "email" | "phone" | "contactId">> = { contactId: contact.id ?? null };
  const name = contact.name?.trim();
  const email = contact.email?.trim();
  const phone = contact.phone?.trim();
  if (name) patch.fullName = name;
  if (email) patch.email = email;
  if (phone && isSigner(me)) patch.phone = phone;
  return updatePerson(people, key, patch, docs);
}

/** What removing a person who must sign takes with them, when the documents have fields assigned to them. */
export interface RemovalAsk {
  key: string;
  name: string;
  fields: number;
  documents: number;
}

/**
 * Does removing this person need asking first? Only a person who must sign and has fields assigned to them: those fields go with them. Anyone
 * else (nothing assigned, or a person who receives a copy) is removed at once (`null`).
 */
export function removalAsk(
  people: readonly EnvelopePerson[],
  key: string,
  docs: readonly { id: string; fromTemplate?: boolean; fieldCounts?: Record<string, number> }[],
  fallbackName: string,
): RemovalAsk | null {
  const me = people.find((p) => p.key === key);
  if (!me || !isSigner(me)) return null;
  const work = assignedWork(people, key, docs);
  if (work.fields <= 0) return null;
  return { key, name: me.fullName.trim() || fallbackName, fields: work.fields, documents: work.documents };
}
