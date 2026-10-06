// ============================================================
// Doc Sign, browser side: attaching a document to a ticket or a deal (F-51) and listing the documents of a contact, ticket or deal.
// The pure rules the screens share, tested without a screen: how a record is named, how a search is made safe, which column finds a
// record's documents, what happens to the links when the contact changes, and the address of "send a document" for a record.
// ============================================================

export type RecordKind = "ticket" | "deal";
/** What a Documents panel lists the documents of. */
export type PanelKind = "contact" | RecordKind;

export interface RecordOption {
  id: string;
  /** The name a person knows it by: `#12 Printer jammed`, `Q4 renewal`. */
  label: string;
  /** A second line: the status, the value. */
  sub: string;
  /** The contact it belongs to, so choosing it can fill the document's contact. */
  contactId: string | null;
}

/** The column of `sign_documents` that holds the id of this kind of record. */
export const DOCUMENT_COLUMN: Record<PanelKind, "contact_id" | "ticket_id" | "deal_id"> = { contact: "contact_id", ticket: "ticket_id", deal: "deal_id" };

export const ticketLabel = (number: number | string, subject: string): string => `#${number} ${subject.trim()}`.trim();

/** Characters that would break a PostgREST filter list are dropped; at most 80 characters. */
export function safeSearch(raw: string): string {
  return raw.replace(/[,()%*\\"]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

/**
 * The `or(...)` filter for typing in a record picker. A ticket is found by its subject, or by its number when the text is a number
 * (`12` or `#12`); a deal by its title. Null when nothing is typed.
 */
export function recordSearchClause(kind: RecordKind, raw: string): string | null {
  const q = safeSearch(raw);
  if (!q) return null;
  if (kind === "deal") return `title.ilike.%${q}%`;
  const digits = /^#?(\d{1,9})$/.exec(q);
  return digits ? `ticket_number.eq.${digits[1]},subject.ilike.%${q}%` : `subject.ilike.%${q}%`;
}

export interface DocumentLinksState {
  contactId: string | null;
  ticketId: string | null;
  dealId: string | null;
}

/**
 * A ticket and a deal must be about the document's contact (the server refuses anything else). When the contact changes, the links
 * to records of the old contact are dropped, so the change is never refused; choosing the same contact again changes nothing.
 */
export function linksAfterContactChange(prev: DocumentLinksState, contactId: string | null): DocumentLinksState {
  if (contactId === prev.contactId) return prev;
  return { contactId, ticketId: null, dealId: null };
}

/**
 * After choosing a ticket or a deal: its contact becomes the document's when the document had none (the server does the same). If
 * the document already has another contact, the pickers only offered records of that contact, so this never conflicts.
 */
export function linksAfterRecord(prev: DocumentLinksState, kind: RecordKind, record: RecordOption | null): DocumentLinksState {
  const next: DocumentLinksState = { ...prev, [kind === "ticket" ? "ticketId" : "dealId"]: record?.id ?? null };
  if (record && !prev.contactId && record.contactId) next.contactId = record.contactId;
  return next;
}

/** The address of the new-document page for a contact, ticket or deal (the ids are ids; the page ignores anything else). */
export function newDocumentHref(args: { contactId?: string | null; ticketId?: string | null; dealId?: string | null; templateId?: string | null }): string {
  const p = new URLSearchParams();
  if (args.contactId) p.set("contactId", args.contactId);
  if (args.ticketId) p.set("ticketId", args.ticketId);
  if (args.dealId) p.set("dealId", args.dealId);
  if (args.templateId) p.set("templateId", args.templateId);
  const q = p.toString();
  return q ? `/sign/new?${q}` : "/sign/new";
}
